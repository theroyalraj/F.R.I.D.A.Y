# -*- coding: utf-8 -*-
"""
Alexa skill (AWS Lambda) → configurable HTTPS backend (e.g. ngrok → N8N).

Aligned with Openclaw:
  - Intents: FridayCommandIntent (slot command), FridayLastResultIntent, AMAZON.* (see skill/interaction-model.json)
  - Command enqueue: POST JSON to openclaw_intake_url with header X-Openclaw-Secret (same shape as skill-gateway enqueueN8n)

Configuration: JSON file **config.json** in the same directory as this module (bundle it in the Lambda deployment zip).
For **AWS Lambda**, intake URL must be **public HTTPS** (ngrok to N8N): from repo root run **`npm run tunnel:n8n`**, then set
`openclaw_intake_url` to `https://<your-ngrok-host>.ngrok-free.app/webhook/friday-intake` (see **config.example.json**).
Keys:
  openclaw_intake_url      — full webhook URL (ngrok → port 5678 → /webhook/friday-intake)
  openclaw_webhook_secret  — same as N8N_WEBHOOK_SECRET
  last_result_url          — optional POST URL: body {"userId"} → JSON {"message"} or {"summary"} (use …/internal/last-result/fetch on skill-gateway)
  awaiting_user_peek_url   — optional POST URL: body {"userId"} → JSON {"pending":{…}} (skill-gateway …/internal/awaiting-user/peek) for Launch reminders
  awaiting_user_clear_url  — optional POST URL: body {"userId"} clears pending (…/internal/awaiting-user/clear); pair with peek for Lambda + gateway
  http_timeout_sec         — number, default 8 (keep under Alexa's response budget)
  ngrok_bypass_value       — optional string, e.g. "69420", sent as ngrok-skip-browser-warning on intake POST
  debug_log_full_envelope  — optional bool; if true, log serialized request envelope at DEBUG for unmatched requests
  intake_probe_on_launch   — optional bool; if true, POST to openclaw_intake_url on every LaunchRequest with commandText set to a fixed ``[Openclaw] launch probe…`` label (not a user command); N8N should skip PC agent when ``lambdaLaunchProbe`` is true — for connectivity debugging only; set **false** in production

**Concurrency:** A process-wide ``ThreadPoolExecutor`` overlaps **blocking I/O** (progressive directive, intake POST, launch probe) with other prep work where allowed. The final Alexa response still waits for **progressive** to finish before returning (Amazon requirement). Intake POST stays **after** progressive so we can branch on HTTP status for the spoken reply.

**Why ngrok shows no requests:** The Lambda only POSTs to ``openclaw_intake_url`` when (1) your Alexa skill **endpoint is this Lambda** (not HTTPS → Node ``/alexa``), and (2) the user triggers **FridayCommandIntent** with a **non-empty** ``command`` slot. Saying only “Alexa, open Friday” is **LaunchRequest** — no intake POST unless ``intake_probe_on_launch`` is true. Watch the ngrok terminal that tunnels **port 5678** (N8N), not 3848. Lambda in a **VPC without NAT** cannot reach the public internet.

**Same “didn't catch that” reprompt** can come from **AMAZON.FallbackIntent** (NLU never matched ``FridayCommandIntent``) or from **FridayCommandIntent** with an **empty** ``command`` slot. Prefer *“Alexa, ask Friday to open Notepad”* instead of doubling *open* with the skill launch phrase.

**Why you see ``response.type`` = ``_DEFAULT_RESPONSE`` (or only ``shouldEndSession: true``):**
  (1) **SessionEndedRequest** — Amazon: no speech. We return an **empty** ``Response()`` so the envelope has ``response: {}`` (ASK SDK pattern). Omitting ``response`` entirely (``None``) confused some Alexa/console paths.
  (2) **Handler returned nothing** — If a handler path forgets ``return`` or raises before returning, the SDK can emit an empty response. CloudWatch will show
  ``ASK trace outbound … response=None`` from the response interceptor.
  (3) **Wrong Lambda return shape** — The skill default endpoint expects a **flat** object: ``version``, ``response``, ``sessionAttributes``, …
  If you wrap the skill JSON inside ``{ "body": { … } }`` or ``{ "statusCode": 200, "body": "…" }`` (API Gateway), Alexa can mis-handle it.
  ``lambda_handler`` **unwraps** inbound API Gateway events (``body`` string/dict) and outbound nested returns when it recognizes an Alexa envelope.
  (4) **``body`` in the Alexa developer console** — Skill **Test** / **Skill I/O** often labels the skill JSON as the **response body** (sometimes shown under a ``body`` field in the UI). That matches how the same payload is sent as the **HTTP POST body** for **HTTPS** skill endpoints. For a **Lambda ARN** endpoint your function still returns a **flat** envelope; the console is describing *where* that JSON sits in the HTTP model, not asking Lambda to return an extra outer ``{ "body": … }`` object. CloudWatch **execution result** for the function shows the actual return value.

CloudWatch lines prefixed with ``ASK trace`` include Amazon's ``requestId``.

If you use the repo's Node skill-gateway on ngrok instead, you do not need this Lambda — point Alexa HTTPS to /alexa on the gateway.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Pattern
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import ask_sdk_core.utils as ask_utils
from ask_sdk_core.dispatch_components import (
    AbstractExceptionHandler,
    AbstractRequestHandler,
    AbstractRequestInterceptor,
    AbstractResponseInterceptor,
)
from ask_sdk_core.handler_input import HandlerInput
from ask_sdk_core.skill_builder import SkillBuilder
from ask_sdk_model.response import Response
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_CONFIG: Optional[Dict[str, Any]] = None

# Shown in N8N/webhook logs when intake_probe_on_launch fires — LaunchRequest has no spoken slot.
_LAUNCH_PROBE_COMMAND_TEXT = (
    "[Openclaw] LaunchRequest connectivity probe — not a spoken command. "
    "Say e.g. 'Alexa, ask Friday to open notepad' for a real task. "
    "Set intake_probe_on_launch false in config.json when done testing tunnels."
)

# Tech / brand tokens: <lang xml:lang="en-US"> when locale is not en-US (bilingual pronunciation).
_ENGLISH_BRAND_TERMS: tuple[str, ...] = tuple(
    sorted(
        (
            "Visual Studio Code",
            "JavaScript",
            "TypeScript",
            "Stack Overflow",
            "PostgreSQL",
            "Kubernetes",
            "MongoDB",
            "GraphQL",
            "OpenAI",
            "MacBook",
            "PowerShell",
            "Bluetooth",
            "WhatsApp",
            "Instagram",
            "Facebook",
            "LinkedIn",
            "Dropbox",
            "OneDrive",
            "iCloud",
            "YouTube",
            "Netflix",
            "Spotify",
            "GitHub",
            "Notion",
            "Slack",
            "Zoom",
            "Figma",
            "Docker",
            "Windows",
            "Android",
            "Ubuntu",
            "Firefox",
            "Chrome",
            "Google",
            "Azure",
            "Claude",
            "Wi-Fi",
            "iPhone",
            "iPad",
            "iOS",
            "Linux",
            "Redis",
            "REST API",
            "npm",
            "npx",
            "SQL",
            "API",
            "AWS",
            "GCP",
            "JWT",
            "OAuth",
            "XSS",
            "CSRF",
            "CORS",
        ),
        key=len,
        reverse=True,
    )
)

_FRIDAY_GREETINGS: tuple[str, ...] = (
    "Hey — what are we tackling on the PC?",
    "Hi there. I am here and ready; what do you need?",
    "Good to see you. Where do you want to start?",
    "Okay, I am listening. Technical stuff, quick tasks, whatever.",
    "What can I help you sort out?",
    "Friday online. Hit me with the messy bit.",
    "Morning, afternoon, or midnight hack — I am in. What is up?",
    "You summoned the nerdy one. What should we break or fix?",
    "PC duty. Apps, files, Claude, chaos — pick your flavor.",
    "I have got bandwidth. What is the mission?",
    "Alright, operator. What are we doing on the machine?",
    "Fresh session. What is the first move?",
    "I am caffeinated and curious. What do you need?",
    "Lay it on me — quick win or deep rabbit hole?",
    "Friday reporting. What is the ticket?",
    "Your bench tech is here. What is broken, boring, or brilliant?",
    "Let us make the PC behave. Where do we start?",
    "No judgment zone. What should I handle?",
    "I am wired in. Command me.",
    "Ready when you are — dumb question or hard problem, both welcome.",
    "What is eating your cycles today?",
    "Skip the small talk if you want — what is the task?",
    "I have seen worse stacks than yours. Probably. What is the ask?",
    "Let us ship something or untangle something. You choose.",
    "PC whisperer mode. What needs whispering?",
    "Friday at your service — sharp, fast, slightly cheeky. What is next?",
    "Got a minute and a goal? Tell me both.",
    "I am the friend who actually likes reading logs. What is up?",
    "We can go surgical or scrappy — what is the vibe?",
    "Your stack, your rules. What are we doing?",
    "I am here for the shortcut and the long fix. Pick one.",
    "What should I poke at on your desktop?",
    "Give me the headline — what do you want done?",
    "I have got tools and opinions. What is the job?",
    "Let us turn intent into clicks. What is the intent?",
    "Friday check-in. What needs doing?",
    "Say the thing you do not want to do manually.",
    "I am listening — bugs, builds, or both?",
    "Your copilot for the boring and the brainy. Which is it?",
    "What is on the plate — fire drill or nice-to-have?",
    "I can nag the PC so you do not have to. What first?",
    "Ready to route power to the right app. What is the target?",
    "Let us keep it moving — what is step one?",
    "I am the easy button with better jokes. What do you need?",
    "Spill the task — I will keep up.",
    "Friday here. Make it weird or make it clean — your call.",
    "What should we automate, open, or explain?",
    "I am tuned for your machine. What is the play?",
)

_LOANWORD_RE: Optional[Pattern[str]] = None

# Reused across warm Lambda invocations; I/O-bound work releases the GIL.
_IO_EXECUTOR: Optional[ThreadPoolExecutor] = None
_IO_EXECUTOR_LOCK = threading.Lock()


def _io_executor() -> ThreadPoolExecutor:
    global _IO_EXECUTOR
    if _IO_EXECUTOR is not None:
        return _IO_EXECUTOR
    with _IO_EXECUTOR_LOCK:
        if _IO_EXECUTOR is None:
            workers = min(8, max(2, (os.cpu_count() or 1) * 2))
            _IO_EXECUTOR = ThreadPoolExecutor(
                max_workers=workers,
                thread_name_prefix="openclaw_io",
            )
    return _IO_EXECUTOR


def _config_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def _load_config() -> Dict[str, Any]:
    global _CONFIG
    if _CONFIG is not None:
        return _CONFIG
    path = _config_path()
    if not os.path.isfile(path):
        logger.warning(
            "Missing config.json (expected %s). Copy config.example.json to config.json.",
            path,
        )
        _CONFIG = {}
        return _CONFIG
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        _CONFIG = raw if isinstance(raw, dict) else {}
    except Exception as e:
        logger.error("Could not read config.json: %s", e)
        _CONFIG = {}
    return _CONFIG


def _cfg_str(key: str, default: str = "") -> str:
    v = _load_config().get(key)
    if v is None:
        return default
    return str(v).strip()


def _cfg_bool(key: str, default: bool = False) -> bool:
    v = _load_config().get(key)
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "on")


def _timeout_sec() -> float:
    try:
        v = float(_load_config().get("http_timeout_sec", 8))
        return max(1.0, min(8.0, v))
    except (TypeError, ValueError):
        return 8.0


def _json_post(
    url: str,
    payload: Dict[str, Any],
    headers: Optional[Dict[str, str]] = None,
) -> tuple[int, str]:
    """Return (status, body). HTTP 4xx/5xx are returned, not raised (urllib raises HTTPError otherwise)."""
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    h = {
        "Accept": "application/json",
        "User-Agent": "OpenclawAlexaLambda/1.0",
        "Content-Type": "application/json",
        **(headers or {}),
    }
    req = Request(url, data=data, headers=h, method="POST")
    try:
        with urlopen(req, timeout=_timeout_sec()) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        return int(e.code), err_body


def _post_gateway_json(url: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """POST JSON to skill-gateway internal route; returns parsed body or None on failure."""
    u = str(url or "").strip()
    if not u.startswith("http"):
        return None
    secret = _cfg_str("openclaw_webhook_secret")
    headers: Dict[str, str] = {}
    if secret:
        headers["X-Openclaw-Secret"] = secret
    try:
        status, body = _json_post(url, payload, headers=headers or None)
        if status >= 400 or not body.strip():
            return None
        out = json.loads(body)
        return out if isinstance(out, dict) else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    except Exception:
        return None


def send_progressive_speak(
    api_endpoint: Optional[str],
    api_access_token: Optional[str],
    request_id: Optional[str],
    ssml: str,
) -> None:
    """Mirror skill-gateway sendProgressiveSpeak (Alexa directives API)."""
    if not api_endpoint or not api_access_token or not request_id:
        return
    url = f"{api_endpoint.rstrip('/')}/v1/directives"
    body = {
        "header": {
            "namespace": "Speech",
            "name": "Speak",
            "payloadVersion": "3",
            "messageId": str(uuid.uuid4()),
            "correlationToken": request_id,
        },
        "directive": {"type": "VoicePlayer.Speak", "speech": ssml},
    }
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    req = Request(
        url,
        data=data,
        headers={
            "Accept": "application/json",
            "User-Agent": "OpenclawAlexaLambda/1.0",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_access_token}",
        },
        method="POST",
    )
    try:
        urlopen(req, timeout=3.0)
    except (HTTPError, URLError, OSError, TimeoutError) as e:
        logger.warning("progressive speak failed: %s", e)


def _term_regex_fragment(term: str) -> str:
    esc = re.escape(term)
    if " " in term:
        return esc
    return r"(?<![A-Za-z0-9])" + esc + r"(?![A-Za-z0-9])"


def _get_loanword_re() -> Pattern[str]:
    global _LOANWORD_RE
    if _LOANWORD_RE is None:
        _LOANWORD_RE = re.compile(
            "|".join(_term_regex_fragment(t) for t in _ENGLISH_BRAND_TERMS),
            re.IGNORECASE,
        )
    return _LOANWORD_RE


def _locale_wants_en_us_loanwords(locale: str) -> bool:
    loc = (locale or "").strip().replace("_", "-").lower()
    return not loc.startswith("en-us")


def _ssml_escape(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _build_ssml_inner(plain: str, locale: Optional[str]) -> str:
    loc = (locale or "en-US").strip().replace("_", "-")
    if _locale_wants_en_us_loanwords(loc):
        parts: List[str] = []
        last = 0
        for m in _get_loanword_re().finditer(plain):
            parts.append(_ssml_escape(plain[last : m.start()]))
            parts.append('<lang xml:lang="en-US">')
            parts.append(_ssml_escape(m.group(0)))
            parts.append("</lang>")
            last = m.end()
        parts.append(_ssml_escape(plain[last:]))
        return "".join(parts)
    return _ssml_escape(plain)


def _build_ssml(text: str, locale: Optional[str] = None) -> str:
    return f"<speak>{_build_ssml_inner(str(text), locale)}</speak>"


# FallbackIntent (NLU did not map to FridayCommand) or empty FridayCommand slot — same coaching.
_RETRY_OPEN_PC_SPEECH = (
    "I didn't catch that. Try: Alexa, ask Friday to open Notepad. "
    "If you used open with the skill name, do not say open again for the app."
)


def _request_locale(handler_input: HandlerInput) -> str:
    try:
        loc = getattr(handler_input.request_envelope.request, "locale", None)
        s = str(loc).strip() if loc else ""
        return s or "en-US"
    except Exception:
        return "en-US"


def _skill_response(
    handler_input: HandlerInput,
    speech: str,
    *,
    end_session: bool,
    reprompt: Optional[str] = None,
    raw_ssml: bool = False,
    raw_reprompt_ssml: bool = False,
) -> Any:
    """
    SSML via SDK speak(). Plain strings are escaped; non–en-US locales wrap common English product
    names in <lang xml:lang="en-US">. Use raw_ssml only for pre-built SSML.
    """
    loc = _request_locale(handler_input)
    s = speech if raw_ssml else _build_ssml(speech, loc)
    rb = handler_input.response_builder.speak(s)
    if reprompt is not None:
        r = reprompt if raw_reprompt_ssml else _build_ssml(reprompt, loc)
        rb.ask(r)
    rb.set_should_end_session(end_session)
    return rb.response


def _session_user_id(handler_input: HandlerInput) -> str:
    try:
        sess = handler_input.request_envelope.session
        if sess and sess.user and sess.user.user_id:
            return sess.user.user_id
    except Exception:
        pass
    try:
        ctx = handler_input.request_envelope.context
        if ctx and ctx.system and ctx.system.user and ctx.system.user.user_id:
            return ctx.system.user.user_id
    except Exception:
        pass
    return "anonymous"


def _pick_friday_greeting_index(handler_input: HandlerInput, pool_size: int) -> int:
    n = max(1, int(pool_size))
    try:
        mgr = handler_input.attributes_manager
        sess = mgr.session_attributes
        if not isinstance(sess, dict):
            sess = {}
            mgr.session_attributes = sess
    except Exception:
        sess = {}
    hist = sess.get("fridayGreetingIxHistory")
    if not isinstance(hist, list):
        hist = []
    avoid = set(hist[-12:])
    choices = [i for i in range(n) if i not in avoid]
    if not choices:
        choices = list(range(n))
    ix = random.choice(choices)
    sess["fridayGreetingIxHistory"] = (hist + [ix])[-20:]
    return ix


def _system_api(handler_input: HandlerInput) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """apiEndpoint, apiAccessToken, requestId for progressive response."""
    req = handler_input.request_envelope.request
    rid = getattr(req, "request_id", None)
    try:
        sys = handler_input.request_envelope.context.system
        ep = sys.api_endpoint
        tok = sys.api_access_token
        return ep, tok, rid
    except Exception:
        return None, None, rid


def _slot_spoken_text(slot: Any) -> str:
    """
    Alexa often sends AMAZON.SearchQuery text only under slot.slot_value (Simple), with top-level
    value empty — especially on in-skill follow-ups. See interaction-model.json.
    ASK Python models may expose either slot_value or slotValue; some payloads use interpretedValue.
    """
    if slot is None:
        return ""
    top = getattr(slot, "value", None)
    if top is not None and str(top).strip():
        return str(top).strip()
    for attr in ("interpreted_value", "interpretedValue"):
        iv = getattr(slot, attr, None)
        if iv is not None and str(iv).strip():
            return str(iv).strip()
    sv = getattr(slot, "slot_value", None) or getattr(slot, "slotValue", None)
    if sv is not None:
        for attr in ("value", "interpreted_value", "interpretedValue"):
            inner = getattr(sv, attr, None)
            if inner is not None and str(inner).strip():
                return str(inner).strip()
        ot = getattr(sv, "object_type", None) or getattr(sv, "objectType", None)
        if ot == "List":
            vals = getattr(sv, "values", None) or []
            for item in vals:
                t = _slot_spoken_text_from_nested_slot_value(item)
                if t:
                    return t
    return _resolutions_spoken_text(getattr(slot, "resolutions", None))


def _slot_spoken_text_from_nested_slot_value(item: Any) -> str:
    if item is None:
        return ""
    v = getattr(item, "value", None)
    if v is not None and str(v).strip():
        return str(v).strip()
    return ""


def _resolutions_spoken_text(resolutions: Any) -> str:
    if resolutions is None:
        return ""
    try:
        rpa = getattr(resolutions, "resolutions_per_authority", None) or []
        for auth in rpa:
            vals = getattr(auth, "values", None) or []
            for vw in vals:
                val = getattr(vw, "value", None)
                if val is None:
                    continue
                name = getattr(val, "name", None)
                if name is not None and str(name).strip():
                    return str(name).strip()
    except Exception:
        pass
    return ""


def _text_from_slot_payload_dict(s: Any) -> str:
    """Extract spoken query from a serialized Alexa slot dict (camelCase + snake_case keys)."""
    if not isinstance(s, dict):
        return ""
    for key in ("value", "interpretedValue", "interpreted_value"):
        v = s.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    sv = s.get("slotValue") or s.get("slot_value")
    if isinstance(sv, dict):
        for key in ("value", "interpretedValue", "interpreted_value"):
            v = sv.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
        type_s = str(sv.get("type") or "").lower()
        if type_s == "list" and isinstance(sv.get("values"), list):
            for item in sv["values"]:
                if isinstance(item, dict):
                    v = item.get("value")
                    if isinstance(v, str) and v.strip():
                        return v.strip()
    return ""


def _command_from_serialized_slots_dict(slots: Any) -> str:
    if not isinstance(slots, dict):
        return ""
    for name in ("command", "Command"):
        t = _text_from_slot_payload_dict(slots.get(name))
        if t:
            return t
    for _k, s in slots.items():
        t = _text_from_slot_payload_dict(s)
        if t:
            return t
    return ""


def _extract_slot_command_serialized(handler_input: HandlerInput) -> str:
    """Last resort: DefaultSerializer often matches what Alexa sent when object attributes look empty."""
    try:
        from ask_sdk_core.serialize import DefaultSerializer

        req = handler_input.request_envelope.request
        intent = getattr(req, "intent", None)
        if not intent or not getattr(intent, "slots", None):
            return ""
        ser = DefaultSerializer().serialize(intent.slots)
        return _command_from_serialized_slots_dict(ser)
    except Exception:
        return ""


def _extract_slot_command_text(handler_input: HandlerInput) -> str:
    """Match skill-gateway slot parsing; supports SearchQuery slotValue + legacy value."""
    try:
        intent = handler_input.request_envelope.request.intent
    except Exception:
        return ""
    if not intent or not intent.slots:
        return ""
    for name in ("command", "Command", "query", "Query", "phrase"):
        slot = intent.slots.get(name)
        if slot is None:
            continue
        raw = _slot_spoken_text(slot)
        if raw:
            return raw
    for _key, slot in intent.slots.items():
        raw = _slot_spoken_text(slot)
        if raw:
            return raw
    fallback = _extract_slot_command_serialized(handler_input)
    if fallback:
        return fallback
    return ""


def _intake_extra_headers() -> Dict[str, str]:
    """Optional: ngrok free tier; mirror repo tunnel header if ngrok_bypass_value is set in config."""
    h: Dict[str, str] = {}
    bypass = _cfg_str("ngrok_bypass_value")
    if bypass:
        h["ngrok-skip-browser-warning"] = bypass
    return h


def _alexa_request_id(handler_input: HandlerInput) -> str:
    try:
        req = handler_input.request_envelope.request
        rid = getattr(req, "request_id", None)
        return str(rid) if rid else "no-request-id"
    except Exception:
        return "no-request-id"


def _alexa_request_detail(handler_input: HandlerInput) -> str:
    """Short label for logs, e.g. LaunchRequest or IntentRequest:FridayCommandIntent."""
    try:
        req = handler_input.request_envelope.request
        name = type(req).__name__
        if hasattr(req, "intent") and req.intent:
            return f"{name}:{getattr(req.intent, 'name', '?')}"
        return name
    except Exception:
        return "unknown"


def _serialize_envelope_for_debug(handler_input: HandlerInput) -> Any:
    try:
        from ask_sdk_core.serialize import DefaultSerializer

        return DefaultSerializer().serialize(handler_input.request_envelope)
    except Exception as e:
        return {"_serialize_error": str(e)}


class AskTraceRequestInterceptor(AbstractRequestInterceptor):
    """Every invocation: log Amazon requestId + type (search CloudWatch for ``ASK trace``)."""

    def process(self, handler_input):
        rid = _alexa_request_id(handler_input)
        detail = _alexa_request_detail(handler_input)
        app_id = "?"
        sess_new = None
        try:
            sys = handler_input.request_envelope.context.system
            app_id = getattr(getattr(sys, "application", None), "application_id", "?")
        except Exception:
            pass
        try:
            s = handler_input.request_envelope.session
            if s is not None:
                sess_new = getattr(s, "new", None)
        except Exception:
            pass
        logger.info(
            "ASK trace inbound requestId=%s request=%s skillId=%s sessionNew=%s",
            rid,
            detail,
            app_id,
            sess_new,
        )
        if _cfg_bool("debug_log_full_envelope"):
            logger.debug(
                "ASK trace envelope requestId=%s %s",
                rid,
                json.dumps(_serialize_envelope_for_debug(handler_input), default=str)[:12000],
            )


class AskTraceResponseInterceptor(AbstractResponseInterceptor):
    def process(self, handler_input, response):
        rid = _alexa_request_id(handler_input)
        if response is None:
            logger.error(
                "ASK trace outbound requestId=%s response=None -> broken handler chain",
                rid,
            )
            return
        try:
            req_name = "?"
            try:
                req_name = type(handler_input.request_envelope.request).__name__
            except Exception:
                pass
            rtype = type(response).__name__
            has_speech = bool(getattr(response, "output_speech", None))
            logger.info(
                "ASK trace outbound requestId=%s requestType=%s responseType=%s hasOutputSpeech=%s",
                rid,
                req_name,
                rtype,
                has_speech,
            )
            if not has_speech and req_name != "SessionEndedRequest":
                logger.warning(
                    "ASK trace outbound requestId=%s requestType=%s has no outputSpeech "
                    "(unexpected unless you intend a non-spoken response)",
                    rid,
                    req_name,
                )
        except Exception as e:
            logger.warning("ASK trace outbound requestId=%s log_error=%s", rid, e)


class LaunchRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("LaunchRequest")(handler_input)

    def handle(self, handler_input):
        rid = _alexa_request_id(handler_input)
        locale = _request_locale(handler_input)
        logger.info(
            "ASK intake note requestId=%s: LaunchRequest does not POST to N8N unless "
            "intake_probe_on_launch=true in config.json. Commands need e.g. "
            "'Alexa, ask Friday to open notepad' (FridayCommandIntent + filled slot).",
            rid,
        )
        probe_future = None
        if _cfg_bool("intake_probe_on_launch"):
            intake_url = _cfg_str("openclaw_intake_url")
            secret = _cfg_str("openclaw_webhook_secret")
            if intake_url and secret:
                api_ep, _, _ = _system_api(handler_input)
                probe = {
                    "correlationId": str(uuid.uuid4()),
                    "source": "alexa",
                    "userId": _session_user_id(handler_input),
                    "locale": locale,
                    "commandText": _LAUNCH_PROBE_COMMAND_TEXT,
                    "requestType": "LaunchRequest",
                    "alexaRequestId": rid,
                    "lambdaLaunchProbe": True,
                    "apiEndpoint": api_ep,
                    "receivedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
                hdrs = {"X-Openclaw-Secret": secret, **_intake_extra_headers()}
                logger.info(
                    "ASK intake HTTP POST (launch probe) requestId=%s url=%s ngrokBypass=%s (worker thread)",
                    rid,
                    intake_url,
                    bool(_cfg_str("ngrok_bypass_value")),
                )
                probe_future = _io_executor().submit(_json_post, intake_url, probe, hdrs)
        gi = _pick_friday_greeting_index(handler_input, len(_FRIDAY_GREETINGS))
        speak = _FRIDAY_GREETINGS[gi]
        rep = speak
        peek_url = _cfg_str("awaiting_user_peek_url")
        if peek_url:
            user_id = _session_user_id(handler_input)
            data = _post_gateway_json(peek_url, {"userId": user_id})
            pending = (data or {}).get("pending") if isinstance(data, dict) else None
            if isinstance(pending, dict) and str(pending.get("prompt") or "").strip():
                p = str(pending["prompt"]).strip()
                speak = (
                    f"Reminder: your PC needs something from you — {p}. "
                    "When you have handled it, say I took care of it. You can also give me a new command."
                )
                rep = "Say I took care of it, or tell me what to do next."
        if probe_future is not None:
            try:
                st, _bd = probe_future.result(timeout=_timeout_sec() + 3.0)
                logger.info(
                    "ASK intake HTTP POST (launch probe) done requestId=%s http_status=%s",
                    rid,
                    st,
                )
            except FuturesTimeoutError:
                logger.error(
                    "ASK intake launch probe timed out requestId=%s",
                    rid,
                )
            except Exception as e:
                logger.exception(
                    "ASK intake launch probe failed requestId=%s err=%s",
                    rid,
                    e,
                )
        return _skill_response(
            handler_input,
            speak,
            end_session=False,
            reprompt=rep,
        )


class FridayAckPendingIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("FridayAckPendingIntent")(handler_input)

    def handle(self, handler_input):
        clear_url = _cfg_str("awaiting_user_clear_url")
        user_id = _session_user_id(handler_input)
        if clear_url:
            _post_gateway_json(clear_url, {"userId": user_id})
        speak = "Got it — I will drop that reminder. What should we tackle next?"
        return _skill_response(
            handler_input,
            speak,
            end_session=False,
            reprompt="Anything else you need?",
        )


class FridayCommandIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("FridayCommandIntent")(handler_input)

    def handle(self, handler_input):
        command_text = _extract_slot_command_text(handler_input)
        rid_cmd = _alexa_request_id(handler_input)

        if not command_text:
            logger.warning(
                "ASK intake skip requestId=%s: FridayCommandIntent with empty command slot — "
                "no HTTP POST. Rebuild the skill model after pulling interaction-model.json; "
                "say the task plainly (e.g. 'open Notepad').",
                rid_cmd,
            )
            rep = _RETRY_OPEN_PC_SPEECH
            return _skill_response(
                handler_input,
                rep,
                end_session=False,
                reprompt=rep,
            )

        intake_url = _cfg_str("openclaw_intake_url")
        secret = _cfg_str("openclaw_webhook_secret")
        if not intake_url or not secret:
            speak = (
                "I am not wired to your backend yet. Add config.json next to this Lambda with "
                "openclaw_intake_url and openclaw_webhook_secret. See config.example.json."
            )
            return _skill_response(handler_input, speak, end_session=True)

        user_id = _session_user_id(handler_input)
        locale = _request_locale(handler_input)
        request_id = getattr(handler_input.request_envelope.request, "request_id", None)
        api_ep, api_tok, _ = _system_api(handler_input)

        progressive_lines = (
            "One sec — on it.",
            "Got you; working on that now.",
            "Okay, give me a moment.",
            "Hang tight, I have got this.",
            "On it — back in a blink.",
            "Routing that to the PC now.",
        )
        prog_ssml = _build_ssml(random.choice(progressive_lines), locale)
        prog_future = _io_executor().submit(
            send_progressive_speak,
            api_ep,
            api_tok,
            request_id,
            prog_ssml,
        )
        received_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        correlation_id = str(uuid.uuid4())
        payload = {
            "correlationId": correlation_id,
            "source": "alexa",
            "userId": user_id,
            "locale": locale,
            "commandText": command_text,
            "requestType": "IntentRequest",
            "alexaRequestId": request_id,
            "apiEndpoint": api_ep,
            "receivedAt": received_at,
        }
        headers = {"X-Openclaw-Secret": secret, **_intake_extra_headers()}
        bypass_on = bool(_cfg_str("ngrok_bypass_value"))
        logger.info(
            "ASK intake HTTP POST (command) requestId=%s url=%s correlationId=%s commandLen=%s ngrokBypass=%s",
            rid_cmd,
            intake_url,
            correlation_id,
            len(command_text),
            bypass_on,
        )
        try:
            prog_future.result(timeout=5.0)
        except FuturesTimeoutError:
            logger.warning(
                "ASK progressive speak wait timed out requestId=%s (continuing to intake)",
                rid_cmd,
            )
        except Exception as e:
            logger.warning(
                "ASK progressive speak wait requestId=%s err=%s",
                rid_cmd,
                e,
            )
        try:
            status, body = _json_post(intake_url, payload, headers=headers)
            logger.info(
                "ASK intake HTTP POST (command) done requestId=%s http_status=%s",
                rid_cmd,
                status,
            )
            if status >= 400:
                logger.warning("intake HTTP %s body=%s", status, body[:300])
                speak = (
                    "Your Openclaw backend returned an error. Check N8N, secrets, and the webhook URL."
                )
                return _skill_response(handler_input, speak, end_session=True)
        except (URLError, OSError, TimeoutError) as e:
            logger.exception("intake POST failed: %s", e)
            speak = "Sorry — I could not reach your Openclaw backend. Check the URL and tunnel."
            return _skill_response(handler_input, speak, end_session=True)

        ack_lines = [
            "On it. I will ping you when there is something worth hearing — or ask for my last result anytime.",
            "Okay, I am on that. When you are ready, ask for the last result and I will walk you through what I found.",
            "Working on it. Grab me for the last result when you want the full story.",
        ]
        speak = random.choice(ack_lines)
        rep = "Anything else you want to do on the PC?"
        return _skill_response(
            handler_input,
            speak,
            end_session=False,
            reprompt=rep,
        )


class FridayLastResultIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("FridayLastResultIntent")(handler_input)

    def handle(self, handler_input):
        provider = _cfg_str("last_result_url")
        user_id = _session_user_id(handler_input)
        if not provider:
            speak = (
                "I do not have last-result storage in this Lambda. "
                "Set last_result_url in config.json to a POST API that returns JSON message, "
                "or use the Openclaw Node skill-gateway on ngrok instead."
            )
            return _skill_response(handler_input, speak, end_session=True)

        secret = _cfg_str("openclaw_webhook_secret")
        headers = {}
        if secret:
            headers["X-Openclaw-Secret"] = secret
        try:
            _, body = _json_post(provider, {"userId": user_id}, headers=headers or None)
            data = json.loads(body) if body.strip() else {}
            msg = (data.get("message") or data.get("summary") or "").strip()
        except Exception as e:
            logger.warning("last-result fetch failed: %s", e)
            msg = ""

        if msg:
            return _skill_response(handler_input, msg, end_session=True)
        return _skill_response(
            handler_input,
            "Nothing new yet — ask me to do something first, then check last result.",
            end_session=True,
        )


class HelpIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.HelpIntent")(handler_input)

    def handle(self, handler_input):
        speak = (
            "I am your Friday — apps, files, Claude jobs on this PC, the nerdy stuff too. "
            "If something on the machine is waiting on you, open me again for the reminder, "
            "or say I took care of it when you are done. What do you want to try?"
        )
        return _skill_response(
            handler_input,
            speak,
            end_session=False,
            reprompt=speak,
        )


class StopCancelIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.StopIntent")(handler_input) or ask_utils.is_intent_name(
            "AMAZON.CancelIntent"
        )(handler_input) or ask_utils.is_intent_name("AMAZON.NavigateHomeIntent")(handler_input)

    def handle(self, handler_input):
        speak = random.choice(
            [
                "Okay, talk soon.",
                "Later — I am here when you need me.",
                "All right, bye for now.",
            ]
        )
        return _skill_response(handler_input, speak, end_session=True)


class FallbackIntentHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_intent_name("AMAZON.FallbackIntent")(handler_input)

    def handle(self, handler_input):
        rep = _RETRY_OPEN_PC_SPEECH
        return _skill_response(handler_input, rep, end_session=False, reprompt=rep)


class UnhandledIntentHandler(AbstractRequestHandler):
    """
    Catch-all for IntentRequest not matched above (new intents in the model, misnamed builds, etc.).
    Without this, the SDK raises 'handler chain not found' for unhandled intents.
    """

    def can_handle(self, handler_input):
        return ask_utils.is_request_type("IntentRequest")(handler_input)

    def handle(self, handler_input):
        try:
            name = ask_utils.get_intent_name(handler_input)
        except Exception:
            name = "unknown"
        logger.info("unhandled intent: %s", name)
        rep = "I am not set up for that yet. Try a command like open Notepad, or say help."
        return _skill_response(handler_input, rep, end_session=False, reprompt=rep)


class SessionEndedRequestHandler(AbstractRequestHandler):
    def can_handle(self, handler_input):
        return ask_utils.is_request_type("SessionEndedRequest")(handler_input)

    def handle(self, handler_input):
        # No outputSpeech / card / directives. Empty Response → response: {} in the envelope (stable for Alexa + ASK SDK).
        return Response()


class CatchAllRequestHandler(AbstractRequestHandler):
    """
    Last resort: request types no other handler matched (e.g. CanFulfillIntentRequest, APL events).
    Without this, the ASK SDK returns ``type: _DEFAULT_RESPONSE`` and you get no useful speech.
    """

    def can_handle(self, handler_input):
        return True

    def handle(self, handler_input):
        rid = _alexa_request_id(handler_input)
        detail = _alexa_request_detail(handler_input)
        logger.error(
            "ASK trace unmatched requestId=%s request=%s — add a handler or fix interaction model",
            rid,
            detail,
        )
        if _cfg_bool("debug_log_full_envelope"):
            logger.info(
                "ASK trace envelope requestId=%s %s",
                rid,
                json.dumps(_serialize_envelope_for_debug(handler_input), default=str)[:12000],
            )
        speak = "I got a request this skill is not set up to handle yet."
        return _skill_response(handler_input, speak, end_session=True)


class CatchAllExceptionHandler(AbstractExceptionHandler):
    def can_handle(self, handler_input, exception):
        return True

    def handle(self, handler_input, exception):
        rid = _alexa_request_id(handler_input)
        logger.error(
            "ASK trace exception requestId=%s err=%s",
            rid,
            exception,
            exc_info=True,
        )
        speak = "Sorry — something glitched. Try again in a second."
        return _skill_response(handler_input, speak, end_session=True)


sb = SkillBuilder()
sb.add_global_request_interceptor(AskTraceRequestInterceptor())
sb.add_global_response_interceptor(AskTraceResponseInterceptor())
sb.add_request_handler(LaunchRequestHandler())
sb.add_request_handler(FridayCommandIntentHandler())
sb.add_request_handler(FridayAckPendingIntentHandler())
sb.add_request_handler(FridayLastResultIntentHandler())
sb.add_request_handler(HelpIntentHandler())
sb.add_request_handler(StopCancelIntentHandler())
sb.add_request_handler(FallbackIntentHandler())
sb.add_request_handler(UnhandledIntentHandler())
sb.add_request_handler(SessionEndedRequestHandler())
sb.add_request_handler(CatchAllRequestHandler())
sb.add_exception_handler(CatchAllExceptionHandler())


def _is_alexa_request_envelope(d: Dict[str, Any]) -> bool:
    return isinstance(d.get("version"), str) and "request" in d


def _is_alexa_response_envelope(d: Dict[str, Any]) -> bool:
    """Skill response envelope after serialization (version + sessionAttributes + userAgent; response may be {})."""
    if not isinstance(d.get("version"), str):
        return False
    if "response" in d:
        return True
    return "sessionAttributes" in d and "userAgent" in d


# If API Gateway merges a forwarded Alexa JSON with proxy metadata, strip noise before ASK deserialize.
_API_GW_REQUEST_NOISE_KEYS = frozenset(
    {
        "resource",
        "path",
        "httpMethod",
        "headers",
        "multiValueHeaders",
        "queryStringParameters",
        "multiValueQueryStringParameters",
        "pathParameters",
        "stageVariables",
        "requestContext",
        "body",
        "isBase64Encoded",
        "rawPath",
        "rawQueryString",
        "cookies",
    }
)


def _normalize_lambda_event_for_ask_sdk(event: Any) -> Any:
    """
    API Gateway HTTP/Lambda proxy invokes often pass the Alexa request JSON inside event['body'] (string or dict).
    The ASK SDK expects the flat Alexa request object only (version, session, context, request).
    """
    if not isinstance(event, dict):
        return event
    if _is_alexa_request_envelope(event):
        noise = [k for k in _API_GW_REQUEST_NOISE_KEYS if k in event]
        if noise:
            cleaned = {k: v for k, v in event.items() if k not in _API_GW_REQUEST_NOISE_KEYS}
            if _is_alexa_request_envelope(cleaned):
                logger.warning(
                    "ASK: Dropped API Gateway keys from Alexa event (was breaking or duplicating body): %s",
                    noise,
                )
                return cleaned
        return event
    body = event.get("body")
    if body is None:
        return event
    raw = body
    if event.get("isBase64Encoded") and isinstance(raw, str):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, OSError, UnicodeDecodeError):
            return event
    inner: Any
    if isinstance(raw, str):
        try:
            inner = json.loads(raw)
        except json.JSONDecodeError:
            return event
    elif isinstance(raw, dict):
        inner = raw
    else:
        return event
    if isinstance(inner, dict) and _is_alexa_request_envelope(inner):
        logger.warning(
            "ASK: Unwrapped API Gateway-style event (body) into flat Alexa request for ASK SDK."
        )
        return inner
    return event


def _unwrap_nested_body_to_skill_envelope(out: Any, depth: int = 0) -> Any:
    """
    Follow repeated ``{ "body": <dict or JSON string> }`` wrappers until we hit a skill envelope
    (``version`` + ``response`` or sessionAttributes shape). Fixes double-wrapped API Gateway / test UIs.
    """
    if depth > 12 or not isinstance(out, dict):
        return out
    if _is_alexa_response_envelope(out):
        return out
    raw = out.get("body")
    if isinstance(raw, str):
        try:
            inner = json.loads(raw)
        except json.JSONDecodeError:
            return out
        return _unwrap_nested_body_to_skill_envelope(inner, depth + 1)
    if isinstance(raw, dict):
        return _unwrap_nested_body_to_skill_envelope(raw, depth + 1)
    return out


def _strip_alexa_default_response_type_flag(envelope: Dict[str, Any]) -> Dict[str, Any]:
    """
    Drop response.type=_DEFAULT_RESPONSE (SDK/console artifact; not in public skill schema).
    Recurses into nested ``body`` so wrapped shapes are cleaned after unwrap.
    """
    if not isinstance(envelope, dict):
        return envelope
    out = dict(envelope)
    r = out.get("response")
    if isinstance(r, dict) and r.get("type") == "_DEFAULT_RESPONSE":
        out["response"] = {k: v for k, v in r.items() if k != "type"}
    body = out.get("body")
    if isinstance(body, dict):
        stripped = _strip_alexa_default_response_type_flag(body)
        if stripped is not body:
            out["body"] = stripped
    return out


def _normalize_lambda_return_for_alexa(out: Any) -> Any:
    """
    Alexa skill (Lambda ARN) expects a flat response envelope: version, sessionAttributes, userAgent, and usually response.

    Unwraps mistaken API Gateway-style returns: { statusCode, body }, or any depth of { body: { … } }.
    """
    if not isinstance(out, dict):
        return out
    # Mistaken API Gateway HTTP API / REST proxy return shape
    if "statusCode" in out and "body" in out:
        b = out["body"]
        if isinstance(b, str):
            try:
                parsed = json.loads(b)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict) and _is_alexa_response_envelope(parsed):
                logger.warning(
                    "ASK: Flattened Lambda return: statusCode+body string → skill envelope (use flat dict for Alexa trigger)."
                )
                out = parsed
        elif isinstance(b, dict) and _is_alexa_response_envelope(b):
            logger.warning(
                "ASK: Flattened Lambda return: statusCode+body object → skill envelope."
            )
            out = b
    was_flat_skill = _is_alexa_response_envelope(out)
    out = _unwrap_nested_body_to_skill_envelope(out)
    if not was_flat_skill and _is_alexa_response_envelope(out):
        logger.warning(
            "ASK: Flattened nested body wrapper(s) → skill envelope. Prefer returning a flat dict for Lambda ARN."
        )
    return _strip_alexa_default_response_type_flag(out)


_ask_sdk_lambda_handler = sb.lambda_handler()


def lambda_handler(event, context):
    event = _normalize_lambda_event_for_ask_sdk(event)
    result = _ask_sdk_lambda_handler(event, context)
    return _normalize_lambda_return_for_alexa(result)
