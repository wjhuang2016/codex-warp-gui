# Codex Warp GUI (macOS)

macOS-only GUI wrapper around `codex exec --json` that renders Codex JSONL events as "Warp-style" blocks, with session management, TODO extraction, and conclusion markdown preview.

## Prereqs

- Node.js + npm
- Rust `1.88.0` (repo includes `rust-toolchain.toml`)
- `codex` CLI available on `PATH` (the app spawns `codex exec --json`)

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
