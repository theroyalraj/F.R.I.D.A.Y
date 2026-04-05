"""Cursor API runtime: checksum, headers, protobuf agent request encoding."""

from __future__ import annotations

import gzip
import hashlib
import os
import platform
import sqlite3
import sys
import time
import uuid
from datetime import datetime
from typing import Dict, List, Tuple
from urllib.parse import urlparse

from .auth_reader import CursorAuthReader
from .constants import DEFAULT_BACKEND_URL, DEFAULT_CURSOR_VERSION
from .proto import ProtobufEncoder
from .tool_enums import ClientSideToolV2


def _normalize_os(system: str) -> str:
    lowered = system.lower()
    return {"linux": "linux", "darwin": "darwin", "windows": "win32"}.get(lowered, lowered or "linux")


def _normalize_arch(arch: str) -> str:
    a = arch.lower()
    if a in ("x86_64", "amd64"):
        return "x64"
    if a in ("aarch64", "arm64"):
        return "arm64"
    return a


class CursorStreamRuntime:
    def __init__(self) -> None:
        self.auth_reader = CursorAuthReader()
        self.base_url = os.environ.get("CURSOR_BACKEND_URL", DEFAULT_BACKEND_URL).rstrip("/")
        self.base_host = self._host_from_url(self.base_url)
        self.cursor_version = os.environ.get("CURSOR_CLIENT_VERSION", DEFAULT_CURSOR_VERSION).strip() or DEFAULT_CURSOR_VERSION
        self.client_os = _normalize_os(platform.system())
        self.client_arch = _normalize_arch(platform.machine())
        self.client_os_version = platform.release() or "unknown"
        self.client_timezone = os.environ.get("TZ", "UTC")
        self.ghost_mode = os.environ.get("CURSOR_GHOST_MODE", "").strip().lower() in ("1", "true", "yes")
        self.new_onboarding = os.environ.get("CURSOR_NEW_ONBOARDING_COMPLETED", "true").strip().lower() in (
            "1", "true", "yes",
        )

        self.DEFAULT_TOOLS = [
            ClientSideToolV2.READ_FILE,
            ClientSideToolV2.LIST_DIR,
            ClientSideToolV2.FILE_SEARCH,
            ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
            ClientSideToolV2.EDIT_FILE,
            ClientSideToolV2.GLOB_FILE_SEARCH,
        ]

    @staticmethod
    def _host_from_url(base_url: str) -> str:
        try:
            p = urlparse(base_url if "://" in base_url else f"https://{base_url}")
            if p.netloc:
                return p.netloc
            if p.path:
                return p.path
        except Exception:
            pass
        return "api2.cursor.sh"

    def generate_hashed_64_hex(self, s: str, salt: str = "") -> str:
        h = hashlib.sha256()
        h.update((s + salt).encode("utf-8"))
        return h.hexdigest()

    def generate_session_id(self, auth_token: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_DNS, auth_token))

    def get_machine_id(self) -> str | None:
        sp = self.auth_reader.storage_path
        if not sp or sp.suffix != ".vscdb":
            return None
        try:
            db_uri = f"file:{sp}?mode=ro&immutable=1"
            conn = sqlite3.connect(db_uri, uri=True, timeout=10.0)
            cur = conn.cursor()
            cur.execute("SELECT value FROM ItemTable WHERE key = 'storage.serviceMachineId'")
            row = cur.fetchone()
            conn.close()
            if row and row[0] is not None:
                v = row[0]
                return v.decode("utf-8", errors="replace") if isinstance(v, bytes) else str(v)
        except Exception:
            pass
        return None

    def generate_cursor_checksum(self, token: str) -> str:
        machine_id = self.get_machine_id() or self.generate_hashed_64_hex(token, "machineId")
        ts = int(time.time() * 1000 // 1000000)
        byte_array = bytearray([
            (ts >> 40) & 255, (ts >> 32) & 255, (ts >> 24) & 255,
            (ts >> 16) & 255, (ts >> 8) & 255, ts & 255,
        ])
        t = 165
        for i in range(len(byte_array)):
            byte_array[i] = ((byte_array[i] ^ t) + (i % 256)) & 255
            t = byte_array[i]
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        encoded = ""
        for i in range(0, len(byte_array), 3):
            a = byte_array[i]
            b = byte_array[i + 1] if i + 1 < len(byte_array) else 0
            c = byte_array[i + 2] if i + 2 < len(byte_array) else 0
            encoded += alphabet[a >> 2]
            encoded += alphabet[((a & 3) << 4) | (b >> 4)]
            if i + 1 < len(byte_array):
                encoded += alphabet[((b & 15) << 2) | (c >> 6)]
            if i + 2 < len(byte_array):
                encoded += alphabet[c & 63]
        return f"{encoded}{machine_id}"

    def encode_message(self, content: str, role: int, message_id: str, chat_mode_enum: int | None) -> bytes:
        msg = b""
        msg += ProtobufEncoder.encode_field(1, 2, content)
        msg += ProtobufEncoder.encode_field(2, 0, role)
        msg += ProtobufEncoder.encode_field(13, 2, message_id)
        if chat_mode_enum is not None:
            msg += ProtobufEncoder.encode_field(47, 0, chat_mode_enum)
        return msg

    def encode_instruction(self, instruction_text: str) -> bytes:
        msg = b""
        if instruction_text:
            msg += ProtobufEncoder.encode_field(1, 2, instruction_text)
        return msg

    def encode_model(self, model_name: str) -> bytes:
        msg = b""
        msg += ProtobufEncoder.encode_field(1, 2, model_name)
        msg += ProtobufEncoder.encode_field(4, 2, b"")
        return msg

    def encode_cursor_setting(self) -> bytes:
        msg = b""
        msg += ProtobufEncoder.encode_field(1, 2, "cursor\\aisettings")
        msg += ProtobufEncoder.encode_field(3, 2, b"")
        unknown6 = ProtobufEncoder.encode_field(1, 2, b"") + ProtobufEncoder.encode_field(2, 2, b"")
        msg += ProtobufEncoder.encode_field(6, 2, unknown6)
        msg += ProtobufEncoder.encode_field(8, 0, 1)
        msg += ProtobufEncoder.encode_field(9, 0, 1)
        return msg

    def encode_metadata(self) -> bytes:
        msg = b""
        msg += ProtobufEncoder.encode_field(1, 2, self.client_os)
        msg += ProtobufEncoder.encode_field(2, 2, self.client_arch)
        msg += ProtobufEncoder.encode_field(3, 2, self.client_os_version)
        msg += ProtobufEncoder.encode_field(4, 2, sys.executable or "python3")
        msg += ProtobufEncoder.encode_field(5, 2, datetime.now().isoformat())
        return msg

    def encode_message_id(self, message_id: str, role: int, summary_id: str | None = None) -> bytes:
        msg = b""
        msg += ProtobufEncoder.encode_field(1, 2, message_id)
        if summary_id:
            msg += ProtobufEncoder.encode_field(2, 2, summary_id)
        msg += ProtobufEncoder.encode_field(3, 0, role)
        return msg

    def encode_agent_request(self, messages: List[Dict], model_name: str, supported_tools: List[int] | None) -> bytes:
        if supported_tools is None:
            supported_tools = self.DEFAULT_TOOLS
        msg = b""
        formatted_messages = []
        message_ids = []
        for user_msg in messages:
            if user_msg.get("role") == "user":
                mid = str(uuid.uuid4())
                formatted_messages.append({
                    "content": user_msg["content"],
                    "role": 1,
                    "messageId": mid,
                    "chatModeEnum": 2,
                })
                message_ids.append({"messageId": mid, "role": 1})
        for fm in formatted_messages:
            mb = self.encode_message(fm["content"], fm["role"], fm["messageId"], fm.get("chatModeEnum"))
            msg += ProtobufEncoder.encode_field(1, 2, mb)
        msg += ProtobufEncoder.encode_field(2, 0, 1)
        msg += ProtobufEncoder.encode_field(3, 2, self.encode_instruction(""))
        msg += ProtobufEncoder.encode_field(4, 0, 1)
        msg += ProtobufEncoder.encode_field(5, 2, self.encode_model(model_name))
        msg += ProtobufEncoder.encode_field(8, 2, "")
        msg += ProtobufEncoder.encode_field(13, 0, 1)
        msg += ProtobufEncoder.encode_field(15, 2, self.encode_cursor_setting())
        msg += ProtobufEncoder.encode_field(19, 0, 1)
        msg += ProtobufEncoder.encode_field(23, 2, str(uuid.uuid4()))
        msg += ProtobufEncoder.encode_field(26, 2, self.encode_metadata())
        msg += ProtobufEncoder.encode_field(27, 0, 1)
        for tool in supported_tools:
            msg += ProtobufEncoder.encode_field(29, 0, tool)
        for mid in message_ids:
            msg += ProtobufEncoder.encode_field(30, 2, self.encode_message_id(mid["messageId"], mid["role"]))
        msg += ProtobufEncoder.encode_field(35, 0, 0)
        msg += ProtobufEncoder.encode_field(38, 0, 0)
        msg += ProtobufEncoder.encode_field(46, 0, 2)
        msg += ProtobufEncoder.encode_field(47, 2, "")
        msg += ProtobufEncoder.encode_field(48, 0, 0)
        msg += ProtobufEncoder.encode_field(49, 0, 0)
        msg += ProtobufEncoder.encode_field(51, 0, 0)
        msg += ProtobufEncoder.encode_field(53, 0, 1)
        msg += ProtobufEncoder.encode_field(54, 2, "agent")
        return msg

    def encode_stream_unified_chat_request(self, messages: List[Dict], model_name: str) -> bytes:
        inner = self.encode_agent_request(messages, model_name, None)
        return ProtobufEncoder.encode_field(1, 2, inner)

    def generate_request_body(self, messages: List[Dict], model_name: str) -> bytes:
        buf = self.encode_stream_unified_chat_request(messages, model_name)
        magic = 0x00
        if len(messages) >= 3:
            buf = gzip.compress(buf)
            magic = 0x01
        length_bytes = bytes.fromhex(format(len(buf), "08x"))
        return bytes([magic]) + length_bytes + buf

    def build_connect_headers(self, auth_token: str) -> Dict[str, str]:
        session_id = self.generate_session_id(auth_token)
        client_key = self.generate_hashed_64_hex(auth_token)
        checksum = self.generate_cursor_checksum(auth_token)
        rid = str(uuid.uuid4())
        return {
            "authorization": f"Bearer {auth_token}",
            "connect-accept-encoding": "gzip",
            "connect-protocol-version": "1",
            "content-type": "application/connect+proto",
            "user-agent": "connect-es/1.6.1",
            "x-amzn-trace-id": f"Root={rid}",
            "x-client-key": client_key,
            "x-cursor-checksum": checksum,
            "x-cursor-client-version": self.cursor_version,
            "x-cursor-client-type": "ide",
            "x-cursor-client-os": self.client_os,
            "x-cursor-client-arch": self.client_arch,
            "x-cursor-client-os-version": self.client_os_version,
            "x-cursor-client-device-type": "desktop",
            "x-cursor-config-version": str(uuid.uuid4()),
            "x-cursor-timezone": self.client_timezone,
            "x-ghost-mode": "true" if self.ghost_mode else "false",
            "x-new-onboarding-completed": "true" if self.new_onboarding else "false",
            "x-request-id": rid,
            "x-session-id": session_id,
            "host": self.base_host,
        }
