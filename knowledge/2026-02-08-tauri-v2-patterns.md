# Tauri v2 Patterns for MuxTunnel

## Tauri v2 Command Pattern

```rust
#[tauri::command]
async fn my_command(
    arg: String,
    state: State<'_, AppState>,
) -> Result<T, String> { ... }
```

- Register with `tauri::generate_handler![cmd1, cmd2, ...]`
- State via `tauri::Builder::manage(state)`
- Frontend: `invoke("my_command", { arg: "value" })` from `@tauri-apps/api/core`

## Channel Streaming (Rust → JS)

```rust
#[tauri::command]
fn stream_data(channel: Channel<MyMessage>) -> Result<(), String> {
    channel.send(MyMessage { ... })?;
    Ok(())
}
```

- JS side: `new Channel<T>(onMessage)` from `@tauri-apps/api/core`
- Pass channel as argument to invoke
- One-way: Rust→JS only. For JS→Rust, use separate invoke calls
- Messages auto-ordered by index counter
- JSON < 8KB sent via eval(), larger via fetch API

## PTY Streaming Architecture

- **Recv (Rust→JS):** `Channel<PtyMessage>` with tagged enum variants (data, pane-info, exit, error)
- **Send (JS→Rust):** `invoke("pty_send", { target, msg })` per message
- **Close:** `invoke("pty_close", { target })`
- Reader runs in `tokio::task::spawn_blocking` since PTY read is blocking I/O
- PtySessionMap tracks active sessions by target string, auto-cleanup on EOF

## Binary Data

- Rust `Vec<u8>` in Channel messages → JS receives as number array (not ArrayBuffer)
- Need `new Uint8Array(message.data)` on JS side to convert
- For raw binary response from commands, use `tauri::ipc::Response::new(bytes)`

## Frontend Auto-Detection

```ts
function isTauri(): boolean {
    return "__TAURI_INTERNALS__" in window; // v2 uses __TAURI_INTERNALS__
}
```

- Use dynamic `import("./tauri")` to keep @tauri-apps/api out of web bundles
- TauriTransportProxy pattern: synchronous interface, async lazy loading inside

## Vite Config for Tauri

- `envPrefix: ["VITE_", "TAURI_"]` — expose TAURI_ENV_* to client
- `strictPort: true` — Tauri expects exact port
- Disable proxy when `TAURI_ENV_PLATFORM` is set (Tauri sets this during `cargo tauri dev`)
- `beforeDevCommand: "npm run dev:vite"` in tauri.conf.json

## macOS Compilation

- Tauri v2 needs: WebKit, Security, CoreServices, AppKit, CoreFoundation frameworks
- In nix: `pkgs.darwin.apple_sdk.frameworks.*`
- Also needs `pkg-config` and `libiconv`
- Icons: 32x32.png, 128x128.png, 128x128@2x.png, icon.icns required

## Gotchas

- `cargo tauri dev` panics if `beforeDevCommand` fails (e.g., port in use)
- Vite with `appType: "spa"` scans ALL HTML files recursively — reference repos in downloads/ caused errors
- `tauri::generate_context!()` panics if icon files don't exist at compile time
- `once_cell::sync::Lazy<Mutex<T>>` is the pattern for global mutable state in Rust modules
- `portable-pty` requires `drop(pair.slave)` after spawning — master/slave separation
