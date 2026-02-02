# Codex Warp GUI (macOS + Web)

GUI wrapper around `codex app-server` that renders Codex events as "Warp-style" blocks, with session management, TODO extraction, usage stats, and conclusion markdown preview.

## Prereqs

- Node.js + npm
- Rust `1.88.0` (repo includes `rust-toolchain.toml`)
- `codex` CLI available on `PATH` (the app/server spawns `codex app-server`)

## Dev

```bash
npm install
npm run tauri dev
```

## Build (macOS app bundle)

```bash
npm run tauri build
```

Outputs:
- `src-tauri/target/release/bundle/macos/Codex Warp.app`
- `src-tauri/target/release/bundle/dmg/Codex Warp_<version>_<arch>.dmg`

## Remote backend (SSE)

This repo also includes a standalone Rust server (`server/`) that exposes session/run APIs plus an SSE stream (`/api/sessions/:id/stream`).

If `dist/` exists, the server will also host the web UI so you can use it from a browser/phone.

Run:

```bash
cargo run --manifest-path server/Cargo.toml -- --bind 0.0.0.0:8765
```

Then open:

- `http://127.0.0.1:8765/` on the same machine
- `http://<LAN-IP>:8765/` from a phone on the same network

Build the web UI if needed:

```bash
npm install
npm run build
```

Notes:
- `--data-dir /path/to/data` (default: `~/.codex-warp`)
- `--codex-path /path/to/codex` (default: search `PATH`)
- `--web-dist /path/to/dist` (optional; default: `../dist` relative to `server/`)

API-only mode (no UI): if `dist/index.html` is missing, the server will return a message on `/`.

## Web UI connection mode

- In a browser, the UI runs in **Remote** mode and calls the server over HTTP+SSE.
- In the macOS app, you can switch **Local / Remote** in Settings.

### SSE endpoint

- `GET /api/sessions/<id>/stream?tail=4000` (Server-Sent Events)
- Event types: `codex_event`, `codex_metrics`, `codex_run_finished`
