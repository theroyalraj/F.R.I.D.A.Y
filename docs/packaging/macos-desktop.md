# macOS desktop (OpenClaw.app)

## Dev

```bash
cd apps/desktop
npm install
npm run tauri dev
```

Requires **Rust** (stable), **Xcode CLI tools** on macOS, and icons under `apps/desktop/icons/` (see `icons/README.md`).

## Release

```bash
cd apps/desktop
npm run tauri build
```

Produces a `.dmg` when `bundle.active` is true and icons are present.

## Auto-update (Tauri updater)

1. Add crates: `tauri-plugin-updater` in `Cargo.toml` and register `.plugin(tauri_plugin_updater::Builder::new().build())` in `lib.rs`.
2. Restore the `plugins.updater` block in `tauri.conf.json` with your **public key** and GitHub Releases URL.
3. Publish `latest.json` + signatures per [Tauri updater](https://v2.tauri.app/plugin/updater/) docs.

Placeholder owner in config: replace `OWNER/openclaw` with your repo path.

## User config

The setup wizard writes `~/.openclaw/config.json`. **skill-gateway** and **pc-agent** load it after `.env`, so keys there override repo env (useful for Anthropic API key and `OPENCLAW_SQLITE_PATH`).

## Embedded DB

Set `OPENCLAW_SQLITE_PATH` to e.g. `$HOME/.openclaw/openclaw.db` for perception + `openclaw_settings` without Docker Postgres.

## Direct intake (no N8N)

Set `OPENCLAW_DIRECT_INTAKE=true` and ensure `PC_AGENT_SECRET` matches `N8N_WEBHOOK_SECRET` (the wizard stores one shared secret for both). The gateway POSTs to pc-agent `/task` and then `/internal/last-result`.
