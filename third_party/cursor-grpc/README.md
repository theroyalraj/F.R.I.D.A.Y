# cursor-grpc protos (reference only)

This folder documents reverse-engineered gRPC definitions for traffic between the **Cursor IDE** and **Cursor’s backend**. Upstream: [Jordan-Jarvis/cursor-grpc](https://github.com/Jordan-Jarvis/cursor-grpc).

## OpenClaw does **not** use these at runtime

- No gRPC client or MITM proxy ships with OpenClaw.
- Composer transcript TTS uses **local JSONL** under `CURSOR_TRANSCRIPTS_DIR`, watched by `scripts/cursor-reply-watch.py` (watchdog + worker queue).

## Why keep this note

The protos are useful **research material** if you ever:

- Decode proxied HTTPS/gRPC in Charles (or similar) for debugging.
- Compare wire shapes (`StreamUnifiedChatWithToolsResponse`, `ConversationThinking`, etc.) to JSONL lines.

They are unofficial, may drift across Cursor versions, and may conflict with ToS if abused—treat as read-only reference.

### File roles (summary)

| Proto | Role |
|-------|------|
| `server_chat.proto` | `ChatService` streaming RPCs; `ContentBlock.text` style payloads |
| `server_stream.proto` | Alternate `UnifiedChatService` bidi stream |
| `server_full.proto` | Rich types: `ConversationThinking`, tool enums (often no `service` block) |
| `server_config.proto` | Server config / billing—not live chat |

Clone the upstream repo locally if you need the actual `.proto` files; do not assume field numbers match production.
