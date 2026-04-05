"""
HTTP/2 ConnectRPC streaming to Cursor ChatService (experimental).
Logs timing stages when FRIDAY_CURSOR_GRPC_LOG is truthy.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from .runtime import CursorStreamRuntime

try:
    import httpx
except ImportError:
    httpx = None  # type: ignore


@dataclass
class GrpcTimingLog:
    t0: float = field(default_factory=time.perf_counter)
    lines: List[str] = field(default_factory=list)

    def emit(self, tag: str) -> None:
        dt = (time.perf_counter() - self.t0) * 1000.0
        line = f"[gRPC:{tag}] +{dt:.1f}ms"
        self.lines.append(line)
        raw = os.environ.get("FRIDAY_CURSOR_GRPC_LOG", "true").strip().lower()
        if raw not in ("0", "false", "no", "off"):
            print(line, flush=True)


def _extract_printable(data: bytes) -> str:
    try:
        t = data.decode("utf-8", errors="ignore")
        return "".join(c for c in t if c.isprintable() or c in "\n\r\t")
    except Exception:
        return ""


def stream_unified_chat(
    prompt: str,
    model: str = "default",
    *,
    on_text_chunk: Optional[Callable[[str], None]] = None,
    max_chunks: int = 500,
    max_chars: int = 200_000,
    timing: Optional[GrpcTimingLog] = None,
) -> str:
    """
    POST StreamUnifiedChatWithTools; accumulate decoded printable text from binary stream.
    Returns full text (best-effort; wire format is protobuf, not plain UTF-8).

    When ``timing`` is provided (e.g. t0 = user-turn detection), emits t1_auth … t5_done
    relative to that anchor. Otherwise creates an internal log from this call.
    """
    if not httpx:
        print("[gRPC] httpx not installed — pip install httpx h2", flush=True)
        return ""
    slog = timing if timing is not None else GrpcTimingLog()
    rt = CursorStreamRuntime()
    token = rt.auth_reader.get_bearer_token()
    if not token:
        slog.emit("t_no_token")
        return ""
    if "::" in token:
        token = token.split("::", 1)[1]
    slog.emit("t1_auth")

    body = rt.generate_request_body([{"role": "user", "content": prompt}], model)
    headers = rt.build_connect_headers(token)
    url = f"{rt.base_url}/aiserver.v1.ChatService/StreamUnifiedChatWithTools"

    full: List[str] = []
    chunk_i = 0
    first_text_chunk = True
    try:
        with httpx.Client(http2=True, timeout=httpx.Timeout(120.0, connect=30.0)) as client:
            with client.stream("POST", url, headers=headers, content=body) as resp:
                if resp.status_code != 200:
                    err = resp.read().decode("utf-8", errors="replace")[:500]
                    slog.emit(f"t_http_{resp.status_code}")
                    print(f"[gRPC] HTTP {resp.status_code}: {err}", flush=True)
                    return ""
                slog.emit("t2_conn")
                for chunk in resp.iter_bytes():
                    if not chunk:
                        continue
                    chunk_i += 1
                    piece = _extract_printable(chunk)
                    if first_text_chunk and len(piece.strip()) > 4:
                        slog.emit("t3_first_chunk")
                        first_text_chunk = False
                    # Heuristic: pull sentence-like runs from noisy binary
                    if len(piece) > 2:
                        full.append(piece)
                        if on_text_chunk:
                            on_text_chunk(piece)
                    if chunk_i >= max_chunks or sum(len(x) for x in full) >= max_chars:
                        break
    except Exception as e:
        slog.emit("t_error")
        print(f"[gRPC] stream error: {e}", flush=True)
        return ""

    text = "".join(full)
    # Collapse noise: keep lines that look like natural language
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", text) if len(ln.strip()) > 8 and " " in ln.strip()]
    cleaned = "\n".join(lines) if lines else text[:8000]
    slog.emit("t5_done")
    return cleaned
