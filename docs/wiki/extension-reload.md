<!-- F-RuleLifecycleMgmt: superseded_by = null ; supersedes = null ; effective_since = v10.7.7 -->

# Extension Reload + Auto-Launch Behavior

## Why this matters

`mcp-chrome` extension uses `chrome.runtime.connectNative` (a long-lived port to the Node bridge) + `chrome.debugger` (internal CDP via extension permission). It does **not** require `--remote-debugging-port=9222` and does not require a separate Chrome instance. It runs against your **normal, already-running Chrome** and reuses your existing login state, bookmarks, and extensions.

This document describes what happens when:

1. You click **Reload** on the extension in `chrome://extensions`.
2. You restart Chrome itself.
3. The bridge (`mcp-chrome-bridge start`) detects that Chrome is not running.

## Reload extension (`chrome://extensions` → Reload)

What happens, in order:

1. Chrome tears down the current extension service worker.
2. The native-messaging host (`mcp-chrome-bridge`, PID changes) is terminated by Chrome.
3. A **new** `mcp-chrome-bridge` process is spawned automatically by Chrome on the next native message.
4. The new bridge listens on `http://127.0.0.1:12306/mcp`.
5. The extension re-establishes the `connectNative` port in its new service worker.
6. The bridge MCP session map is reset to empty (process restart).

What this means for `mcp__mcp_chrome__*` tool calls:

- Calls that arrive **before step 5 completes** (typically 1-2 seconds after Reload) may receive an HTTP 400 or a stale session error.
- Once the new bridge is up, the **first** call from Codex will succeed (Codex re-initializes automatically on 400 via the bridge HTTP retry).
- **Recommended:** wait ~3 seconds after Reload before issuing tool calls. Or run `mcp-chrome-bridge doctor` to confirm the bridge is healthy.

What you do **not** need to do:

- Restart Chrome.
- Restart Codex.
- Run `mcp-chrome-bridge register` again.
- Reload the unpacked extension path.

## Restart Chrome itself

If you fully quit Chrome (close all windows) and reopen it:

1. The previous `mcp-chrome-bridge` process is terminated.
2. The next time the extension sends a native message, Chrome spawns a new bridge.
3. The new bridge listens on the same port (`12306` by default) and the cycle above repeats.
4. Your existing tabs, login state, and the loaded unpacked extension are restored from your user profile.

If you want `mcp-chrome-bridge start` to be more polite about this case, see the next section.

## `mcp-chrome-bridge start` auto-launches Chrome

Implemented in commit `f1be061`. When you run:

```
mcp-chrome-bridge start --port 12306
```

the bridge will:

1. Probe whether Chrome is already running (`tasklist /FI "IMAGENAME eq chrome.exe"` on Windows, `pgrep chrome` on mac/Linux).
2. If **not** running, spawn a plain `chrome.exe` / `open -a "Google Chrome"` / `google-chrome` process. **No** `--remote-debugging-port` flag is added (mcp-chrome does not need it).
3. Poll for up to 10 seconds waiting for Chrome to come up.
4. Log the result (e.g. `[ensure-chrome] Chrome spawned successfully (PID 12345)`).
5. Start the HTTP MCP server on the requested port.

If the spawn fails (Chrome not in `PATH`, permission denied, etc.), the bridge logs a warning and continues starting the MCP server. You can manually start Chrome and the bridge will pick it up on the next native message.

What the spawn does **not** do:

- It does not add `--remote-debugging-port=9222`. You do not need that flag for `mcp-chrome` to work; it is only required by Puppeteer / Playwright / `chrome-devtools-mcp` style tools.
- It does not use an isolated `--user-data-dir`. It uses your default profile so your existing login state, cookies, bookmarks, and unpacked extensions (including `mcp-chrome` itself) are all available immediately.
- It does not load the extension automatically. You load the unpacked extension once via `chrome://extensions` and it persists across restarts.

## Health check

You can verify the bridge is healthy with:

```
curl http://127.0.0.1:12306/health
```

(See commit history for when this endpoint is added.) The response includes:

- `bridgeEpoch`: a UUID generated when the bridge started. Changes on every restart.
- `extensionConnected`: whether the extension has registered itself since the bridge started.
- `lastHeartbeat`: timestamp of the most recent extension heartbeat (for `mcp__mcp_chrome__*` keepalive).
- `tabCount`: number of tabs the bridge currently tracks.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `mcp__mcp_chrome__*` returns HTTP 400 right after Reload | Old MCP session id; new bridge not yet up | Wait 2-3 seconds, retry. Or `mcp-chrome-bridge doctor` to confirm health. |
| `mcp__mcp_chrome__*` consistently returns 400 for >10s | New bridge failed to bind 12306 (port in use) | `netstat -ano | findstr 12306` on Windows; kill stale process. |
| `chrome_screenshot` returns base64 but file is not at the path I gave | `savePath` integration is in commit `013be6e`; your bridge is older | `git pull` and rebuild native-server + reload extension. |
| `[ensure-chrome] Failed to spawn Chrome; user must start it manually` | `chrome.exe` not in `PATH` | Add Chrome to PATH, or call `mcp-chrome-bridge register` once after fixing. |
| `tasklist` returns `INFO: No tasks are running which match the specified criteria.` | Chrome not running (expected) | The `ensure-chrome` logic will spawn it; if that also failed, start Chrome manually. |

## Compatibility matrix

| Client | Needs `--remote-debugging-port=9222`? | Compatible with `mcp-chrome`? |
|---|---|---|
| `mcp-chrome-bridge` (this project) | No | Yes (native messaging + extension-internal CDP) |
| `chrome-devtools-mcp` | Yes (external CDP) | No (separate tool) |
| `puppeteer` / `playwright` | Yes (external CDP) | No (separate tool) |

If you later add a `chrome-devtools-mcp` style server in the same project, you would add `--remote-debugging-port=9222` to `ensureChrome()` in `app/native-server/src/scripts/ensure-chrome.ts`. For now, **do not** add it.
