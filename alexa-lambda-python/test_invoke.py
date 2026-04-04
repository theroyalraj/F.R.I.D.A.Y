#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Local shell tests for lambda_function.lambda_handler (no real AWS, no real ngrok).

Run from this directory:
  pip install -r requirements.txt
  python test_invoke.py

Uses unittest.mock to stub outbound HTTP; forces in-memory config via module _CONFIG.
"""

from __future__ import annotations

import json
import os
import sys
import unittest.mock
from typing import Any, Dict

# Directory containing lambda_function.py
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _context() -> Any:
    class C:
        function_name = "openclaw-local-test"
        memory_limit_in_mb = 256
        invoked_function_arn = "arn:aws:lambda:us-east-1:000000000000:function:openclaw-local-test"
        aws_request_id = "aws-local-test-1"

    return C()


def _envelope(request: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "version": "1.0",
        "session": {
            "new": True,
            "sessionId": "amzn1.echo-api.session.localtest",
            "application": {"applicationId": "amzn1.ask.skill.localtest"},
            "user": {"userId": "amzn1.ask.account.localtest"},
        },
        "context": {
            "System": {
                "application": {"applicationId": "amzn1.ask.skill.localtest"},
                "user": {"userId": "amzn1.ask.account.localtest"},
                "apiEndpoint": "https://api.fe.amazonalexa.com",
                "apiAccessToken": "local-test-token",
            }
        },
        "request": request,
    }


def _apply_test_config(lf: Any) -> None:
    lf._CONFIG = {
        "openclaw_intake_url": "https://example.invalid/webhook/friday-intake",
        "openclaw_webhook_secret": "test-webhook-secret",
        "last_result_url": "",
        "http_timeout_sec": 8,
        "ngrok_bypass_value": "",
        "debug_log_full_envelope": False,
        "intake_probe_on_launch": True,
    }


def main() -> int:
    import lambda_function as lf

    _apply_test_config(lf)

    posts: list = []

    def fake_json_post(url, payload, headers=None):
        posts.append({"url": url, "payload": payload, "headers_keys": sorted((headers or {}).keys())})
        return 202, "{}"

    ctx = _context()

    print("=== Openclaw Alexa Lambda local tests ===\n")

    with unittest.mock.patch.object(lf, "_json_post", side_effect=fake_json_post):
        with unittest.mock.patch.object(lf, "send_progressive_speak"):
            # 1) LaunchRequest (+ launch probe POST if enabled in config)
            launch = _envelope(
                {
                    "type": "LaunchRequest",
                    "requestId": "amzn1.echo-api.request.launch1",
                    "timestamp": "2026-04-04T12:00:00Z",
                    "locale": "en-US",
                }
            )
            r1 = lf.lambda_handler(launch, ctx)
            assert r1.get("version") == "1.0", r1
            assert "response" in r1
            assert r1["response"].get("shouldEndSession") is False
            print("OK LaunchRequest -> version 1.0, has response")
            assert len(posts) >= 1, "launch probe should call _json_post once"
            assert posts[0]["payload"].get("lambdaLaunchProbe") is True
            assert "[Openclaw]" in (posts[0]["payload"].get("commandText") or "")
            print(f"OK launch probe POST recorded (url={posts[0]['url'][:40]}...)")

            posts.clear()

            # 2) FridayCommandIntent with command slot
            cmd = _envelope(
                {
                    "type": "IntentRequest",
                    "requestId": "amzn1.echo-api.request.cmd1",
                    "timestamp": "2026-04-04T12:00:01Z",
                    "locale": "en-US",
                    "intent": {
                        "name": "FridayCommandIntent",
                        "slots": {
                            "command": {
                                "name": "command",
                                "value": "open notepad",
                                "confirmationStatus": "NONE",
                            }
                        },
                    },
                }
            )
            r2 = lf.lambda_handler(cmd, ctx)
            assert r2.get("version") == "1.0"
            assert "response" in r2
            assert r2["response"].get("shouldEndSession") is False, r2
            assert r2["response"].get("outputSpeech", {}).get("type") == "SSML"
            assert r2["response"].get("reprompt") is not None
            print("OK FridayCommandIntent -> has response")
            assert len(posts) == 1, posts
            assert posts[0]["payload"].get("commandText") == "open notepad"
            assert posts[0]["payload"].get("source") == "alexa"
            assert "X-Openclaw-Secret" in (posts[0].get("headers_keys") or [])
            print("OK intake POST payload has commandText + secret header key")

            posts.clear()

            # 3b) SearchQuery often sends only slotValue (no top-level value) — e.g. in-skill follow-up
            cmd_slotvalue = _envelope(
                {
                    "type": "IntentRequest",
                    "requestId": "amzn1.echo-api.request.cmd2",
                    "timestamp": "2026-04-04T12:00:01Z",
                    "locale": "en-US",
                    "intent": {
                        "name": "FridayCommandIntent",
                        "slots": {
                            "command": {
                                "name": "command",
                                "slotValue": {"type": "Simple", "value": "open calculator"},
                            }
                        },
                    },
                }
            )
            r2b = lf.lambda_handler(cmd_slotvalue, ctx)
            assert len(posts) == 1, posts
            assert posts[0]["payload"].get("commandText") == "open calculator"
            assert r2b.get("version") == "1.0"
            print("OK FridayCommandIntent slotValue-only -> commandText extracted")

            posts.clear()

            # 3c) interpretedValue only (some SearchQuery payloads)
            cmd_interp = _envelope(
                {
                    "type": "IntentRequest",
                    "requestId": "amzn1.echo-api.request.cmd3",
                    "timestamp": "2026-04-04T12:00:01Z",
                    "locale": "en-US",
                    "intent": {
                        "name": "FridayCommandIntent",
                        "slots": {
                            "command": {
                                "name": "command",
                                "slotValue": {
                                    "type": "Simple",
                                    "interpretedValue": "open notepad",
                                },
                            }
                        },
                    },
                }
            )
            r2c = lf.lambda_handler(cmd_interp, ctx)
            assert len(posts) == 1, posts
            assert posts[0]["payload"].get("commandText") == "open notepad"
            assert r2c.get("version") == "1.0"
            print("OK FridayCommandIntent interpretedValue -> commandText extracted")

            posts.clear()

            # 3) Help
            help_ev = _envelope(
                {
                    "type": "IntentRequest",
                    "requestId": "amzn1.echo-api.request.help1",
                    "timestamp": "2026-04-04T12:00:02Z",
                    "locale": "en-US",
                    "intent": {"name": "AMAZON.HelpIntent", "slots": {}},
                }
            )
            r3 = lf.lambda_handler(help_ev, ctx)
            assert r3.get("version") == "1.0"
            assert len(posts) == 0
            print("OK HelpIntent -> no intake POST")

            # 4) SessionEndedRequest — empty Response → response: {} (no speech, stable envelope)
            ended = _envelope(
                {
                    "type": "SessionEndedRequest",
                    "requestId": "amzn1.echo-api.request.end1",
                    "timestamp": "2026-04-04T12:00:03Z",
                    "reason": "USER_INITIATED",
                }
            )
            r4 = lf.lambda_handler(ended, ctx)
            assert r4.get("version") == "1.0"
            assert r4.get("response") == {}, r4
            assert "outputSpeech" not in (r4.get("response") or {})
            print("OK SessionEndedRequest -> empty response object")

            # 5) API Gateway–style inbound event (body = JSON string)
            gw_launch = {
                "httpMethod": "POST",
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps(launch),
            }
            posts.clear()
            r5 = lf.lambda_handler(gw_launch, ctx)
            assert r5.get("version") == "1.0"
            assert "response" in r5
            print("OK API Gateway-shaped inbound event -> skill still works")

            # 5b) Merged: flat Alexa envelope + API Gateway noise (duplicate body) — strip noise
            merged = dict(launch)
            merged["httpMethod"] = "POST"
            merged["body"] = json.dumps(launch)
            posts.clear()
            r5b = lf.lambda_handler(merged, ctx)
            assert r5b.get("version") == "1.0"
            assert "response" in r5b
            print("OK merged Alexa + API Gateway noise -> noise stripped, skill works")

            # 6) Normalize mistaken statusCode+body return shape
            flat = lf._normalize_lambda_return_for_alexa(
                {
                    "statusCode": 200,
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps(
                        {"version": "1.0", "response": {"shouldEndSession": True}}
                    ),
                }
            )
            assert flat.get("version") == "1.0" and flat.get("response", {}).get("shouldEndSession") is True
            print("OK statusCode+body outbound normalized to flat envelope")

            # 7) SessionEnded-style envelope nested under body — still unwraps
            flat2 = lf._normalize_lambda_return_for_alexa(
                {
                    "body": {
                        "version": "1.0",
                        "sessionAttributes": {},
                        "userAgent": "ask-python/1.19.0",
                        "response": {},
                    }
                }
            )
            assert flat2.get("version") == "1.0"
            assert flat2.get("response") == {}
            assert flat2.get("sessionAttributes") == {}
            print("OK nested body + minimal response {} unwraps to flat")

            # 8) Double-nested body + strip response.type _DEFAULT_RESPONSE
            flat3 = lf._normalize_lambda_return_for_alexa(
                {
                    "body": {
                        "body": {
                            "version": "1.0",
                            "sessionAttributes": {},
                            "userAgent": "ask-python/1.19.0",
                            "response": {
                                "outputSpeech": {
                                    "type": "SSML",
                                    "ssml": "<speak>Hi</speak>",
                                },
                                "shouldEndSession": False,
                                "type": "_DEFAULT_RESPONSE",
                            },
                        }
                    }
                }
            )
            assert flat3.get("version") == "1.0"
            assert "type" not in (flat3.get("response") or {})
            assert flat3.get("response", {}).get("outputSpeech", {}).get("type") == "SSML"
            print("OK double-nested body unwraps; _DEFAULT_RESPONSE type stripped")

    print("\nSample Help response (trimmed):")
    print(json.dumps(r3, indent=2)[:800])
    print("\nAll tests passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as e:
        print("FAIL:", e, file=sys.stderr)
        raise SystemExit(1)
    except ImportError as e:
        print("Install deps: pip install -r requirements.txt", file=sys.stderr)
        print(e, file=sys.stderr)
        raise SystemExit(2)
