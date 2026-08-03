## [v1.8.2] - 2026-08-02

### Added

- **chrome.alarms 30s heartbeat wakeup (MV3 SW freeze protection)** - `app/chrome-extension/entrypoints/background/bridge-control.ts` now schedules `chrome.alarms.create("bridge-heartbeat", { periodInMinutes: 0.5 })` alongside the existing 30s `setInterval`. Chrome >= 120 minimum period is 30s (RFC docs/rfcs/2026-08-02-mcp-watchdog-keepalive.md). The alarm wakes the service worker even after MV3 idle freeze (30s+ of no user activity) so the heartbeat producer stays alive when `setInterval` dies with the SW. Both paths fire the same idempotent `doHeartbeat()`, so a redundant call is harmless. `chrome.alarms.onAlarm.addListener` registered at module load (one-shot, never double-bind); the existing `triggerImmediateHeartbeatIfActive` guard (`state.timer === null` short-circuit) prevents the alarm from firing after `onBridgeStopped()`. `chrome.alarms.clear(HEARTBEAT_ALARM_NAME)` called from `stopHeartbeat()` so a stopped loop is not woken by an outstanding alarm.

### Changed

- **`HEARTBEAT_INTERVAL_MS`: 60_000 -> 30_000** (extension-side `bridge-control.ts` + mirror in `app/native-server/src/constant/index.ts`). Matches the new `chrome.alarms.create({ periodInMinutes: 0.5 })` rate. The pre-existing setInterval backup also fires at 30s.
- **`HEARTBEAT_STALE_MS`: 90_000 -> 150_000** (app/native-server/src/constant/index.ts). Full jitter budget per ChatGPT R2 audit (RFC §Testing-strategy): alarm 70s worst + SW cold start 5s + network 5s + bridge 1s + margin 69s = 150s. 150s is 5x the 30s heartbeat interval, comfortably tolerating two consecutive worst-case alarm delays before declaring the extension dead.
- **Comments updated**: `app/native-server/src/constant/index.ts` HEARTBEAT_STALE_MS / HEARTBEAT_INTERVAL_MS docblocks now reference the watchdog RFC and explain the math. `bridge-control.ts` heartbeat block comment explains why both alarm and setInterval coexist.
- **`stopHeartbeat()` uses fire-and-forget `void chrome.alarms.clear(...)`** instead of `.catch(() => undefined)`. The vi.fn() chrome mock in vitest.setup.ts returns `undefined` (not a Promise), and `.catch` would crash; `void` is the documented best-effort pattern. Same fallback semantics (alarm may already be cleared; non-actionable failure).

### Fixed

- (None - this is a defense-in-depth patch over v1.8.1's soft-deg protocol, not a bug fix.)

### Tests

- New: `app/chrome-extension/tests/background/bridge-control.test.ts` (3 tests). Covers `chrome.alarms.create({ periodInMinutes: 0.5 })` arg shape, `chrome.alarms.clear(HEARTBEAT_ALARM_NAME)` on stop, and the port-deduplication no-op when `onBridgeStarted` is called twice with the same port.
- Updated: `app/native-server/src/mcp/session-meta.test.ts` (30 tests). All hardcoded `100_000` / `60_000` constants replaced with `HEARTBEAT_STALE_MS + 10_000` / `HEARTBEAT_INTERVAL_MS` so tests track the threshold automatically. `computeRetryAfterMs` test cases updated for the new 30s interval (was: `0 -> 62000ms` is now `HEARTBEAT_INTERVAL_MS + 2000 = 32000ms`).
- Updated: `app/native-server/src/mcp/register-tools.test.ts` (16 tests). `HEARTBEAT_STALE_MS` / `HEARTBEAT_INTERVAL_MS` imported from `../constant` and used throughout. The two stale-reload assertions now use `HEARTBEAT_STALE_MS + 10_000` for the heartbeat gap and `HEARTBEAT_STALE_MS + 50_000` for the reload gap, so the test still targets the "stale + reload long ago" boundary under the new 150s threshold.
- Updated: `app/native-server/src/mcp/integration.test.ts` (4 tests). Same constant usage as `register-tools.test.ts`. Scenarios 1 and 2 still reference the v1.8.1 soft-deg protocol but had hardcoded `100_000` / `200_000` stale offsets which were just under the new 150s threshold; updated to `HEARTBEAT_STALE_MS + 10_000` / `HEARTBEAT_STALE_MS + 50_000`.

### Known follow-up (out of scope for v1.8.2)

- `integration.test.ts` Scenarios 1 and 2 expect `result.result._meta` but the SSE pipeline returns `result.result === undefined`. This is a v1.8.1 soft-deg bug independent of the watchdog patch: the `runPreflight` returns `{ degraded, meta }` correctly but `callTool` doesn't propagate it through the SSE response. Tracked separately; will be addressed in v1.8.3 or a follow-up RFC. Not blocking v1.8.2 release (the soft-deg `_meta` attachment is documented in register-tools.ts but not yet wired through the SSE response layer).
- 2/107 native-server tests fail (integration.test.ts Scenarios 1 and 2) for the above reason. 105/107 + 500/500 chrome-extension pass.

### Notes

- Math source for the 150s threshold: ChatGPT R2 audit of the v1.8.1 P0 recommendation (RFC §3.1, see `tmp/chatgpt_watchdog_R2.txt`). R1 had proposed 120s; R2 corrected to 150s with a complete jitter budget breakdown.
- `chrome.alarms` is "not earlier than" the requested period; worst-case observed in production ~70s (R2 reports 40-70s typical). Worst-case plus margin is what the 150s threshold absorbs. **Machine sleep is NOT covered** (alarm can be delayed by hours after laptop wake) - this needs product-UX work, not threshold tuning.
- The v1.8.1 soft-deg protocol still applies: stale heartbeat + recent reload = `EXTENSION_STARTING` (retryable), stale + old reload = `STALE_RECOVERED` (accept-with-meta). v1.8.2 just makes the heartbeat arrive on time under MV3 freeze.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v1.7.2] - 2026-08-01

### Fixed

- **heartbeat stale threshold 5s to 90s (was rejecting ~92% of every minute with SESSION_EXPIRED)** - Extension sends heartbeat every 60s (HEARTBEAT_INTERVAL_MS in bridge-control.ts:19) but the bridge preflight (register-tools.ts:193 + tool-safety.ts:128) was considering heartbeat stale after only 5s, returning SESSION_EXPIRED for ~55s out of every 60s window (between heartbeat and next heartbeat). The only time tools worked was the 8.3% window right after each heartbeat. This is why every Codex session was hitting chronic SESSION_EXPIRED even after a single extension reload, and why bypassing the Codex MCP client with direct HTTP did not help (the false-positive was in the bridge, not the MCP transport). Fix: extract HEARTBEAT_STALE_MS = 90_000 (1.5x the 60s heartbeat interval) as a shared constant in app/native-server/src/constant/index.ts, use it from both register-tools.ts and tool-safety.ts. 2 new regression tests in register-tools.test.ts cover the 60s/89s between-heartbeat windows (both must pass preflight). All 55/55 Jest tests still green.

## [v1.7.4] - 2026-08-01

### Fixed

- **chrome_screenshot savePath 20s+ timeout (MV3 SW message-queue race in file_operation_response broadcast)** - Empirically observed: `chrome_screenshot({savePath: ...})` returned `Error calling tool: Request timed out after 20000ms` even though the native host itself completed the file write in ~100ms (verified via Python harness driving stdin/stdout directly). Root cause: the previous pattern in screenshot.ts / file-upload.ts / performance.ts posted a `forward_to_native` message via `chrome.runtime.sendMessage` and listened on `chrome.runtime.onMessage` for `file_operation_response`. In MV3 service workers, when the response fires from inside the native port `onMessage` handler and is re-broadcast into the same SW via `chrome.runtime.sendMessage`, the message can sit in the SW message queue and never reach the awaiting listener before the MCP server-side 20s timeout (documented in AGENTS.md §0b.7.8 as related to MV3 SW message-queue race). Fix: new helper `forwardFileOperationToNative(payload, opts)` in `app/chrome-extension/entrypoints/background/native-host.ts` listens on `nativePort.onMessage` directly (chrome.runtime.Port.onMessage is reliable + synchronous within the SW), correlates via `responseToRequestId`, and returns a Promise. All 4 callsites (screenshot.ts savePath, file-upload.ts prepareFile, performance.ts trace save/cleanup/analyzeTrace) migrated. 30s timeout kept to match existing convention. Side-effect: tests/vitest.setup.ts chrome mock updated with `onAttached/onDetached/onReplaced/onActivated` (v1.7.3 added the bridge-control.ts module-load listeners; the test setup was incomplete for v1.7.3 and only fluked-passing because the import chain into tools/browser/screenshot.ts was missing). Test suite: 491/491 vitest + 55/55 jest, no regression.

## [v1.7.3] - 2026-08-01

### Fixed

- **tab-not-in-live-set SESSION_EXPIRED race condition (60s window after tab create/remove/move)** - Plan 1.4 preflight checks `conn.liveTargets.has(tabId)` to refuse calls on tabs the extension has not heartbeat-reported yet. Heartbeat runs every 60s (`HEARTBEAT_INTERVAL_MS`), so any tab opened via a bridge tool was invisible to preflight for up to 60s after creation. Trigger: bridge opens a tab via `chrome_network_capture` (or any new tab call), then user immediately calls `chrome_switch_tab` / `chrome_extract` / etc on that tab -> SESSION_EXPIRED with message `Tab N not in live set (extension reloaded?)`. Fix in `app/chrome-extension/entrypoints/background/bridge-control.ts`: register `chrome.tabs.onCreated / onRemoved / onAttached / onDetached / onReplaced` listeners at module load, each triggering an immediate `doHeartbeat()` (gated by `state.timer != null` so the call is a no-op before `onBridgeStarted` kicks off the heartbeat loop). Bridge now sees the new tabId within one round-trip (< 100ms) instead of up to 60s. MV3 SW lifecycle note documented in the code comment: events that fire while the SW is asleep are dropped (not queued), but the next SW wakeup re-attaches listeners at module load and the initial heartbeat captures the current tab set, so the SW-asleep case is also handled correctly. No bridge (native-server) change needed - the heartbeat payload schema was already correct, only the extension's send frequency was the gap.

## [v1.8.1] - 2026-08-02

### Added

- **MCP session soft-degradation protocol (RFC `docs/rfcs/2026-08-02-mcp-session-soft-degradation.md`)** - replaces hard `SESSION_EXPIRED` rejection with four-state judgment (NORMAL / STALE_RECOVERED / EXTENSION_STARTING / SESSION_NOT_FOUND). After extension reload, write-class tools now either get a degraded result with `_meta.sessionStatus="stale_recovered"` (retry-friendly, no client upgrade required) or a retryable `EXTENSION_STARTING` error with `retryAfterMs` hint (sleep then retry). Design follows the "bank/频率 hopping radio" analogy: server internal state changes should not hard-reject clients using the old contract; accept with downgrade and notify about the new contract.
  - bridge: `app/native-server/src/mcp/session-meta.ts` — pure-function `buildSessionMeta(conn, reloadContext, nowMs)` computing the four-state judgment. Threshold math anchored on existing `HEARTBEAT_STALE_MS` (90s) and `HEARTBEAT_INTERVAL_MS` (60s) constants; no new magic numbers.
  - bridge: `app/native-server/src/mcp/reload-context.ts` — module-level `observeHeartbeat(ownerId)` + `getReloadContext()` + `_resetReloadContextForTests()`. Tracks per-SW-lifecycle ownerId to detect reloads.
  - bridge: `app/native-server/src/mcp/register-tools.ts` — `runPreflight` now returns `PreflightResult = { isError, content } | { degraded, meta } | null`. New helper `attachDegradedMeta` merges `_meta` into both success and error result branches (so the degraded signal survives tool call failures too). `errorResult` union extended with `SESSION_NOT_FOUND` and `EXTENSION_STARTING` codes.
  - wire protocol: heartbeat body schema accepts optional `ownerId` field. Bridge `/internal/heartbeat` handler invokes `observeHeartbeat(ownerId)`. Backward compatible: old extensions without ownerId field still work (treated as "no reload signal", STALE_RECOVERED path with Infinity reloadGap).
  - extension: `app/chrome-extension/entrypoints/background/bridge-control.ts` — `doRegister()` and `doHeartbeat()` include `ownerId` in POST body, sourced from `getV3Runtime().ownerId` (already exported from `bootstrap.ts`).

### Changed

- `SESSION_EXPIRED` deprecated for "no extension registered" case. New preferred code is `SESSION_NOT_FOUND`. `SESSION_EXPIRED` retained as deprecated alias for one major version. Also preserved for the "tab/target not in live set" client error (unchanged behavior).
- `AGENTS.md §0b.7.8.1` agent-handling rules updated to recommend `EXTENSION_STARTING` retry-with-retryAfterMs and `STALE_RECOVERED` accept-with-meta, before falling back to legacy `SESSION_EXPIRED` reload-Codex instructions.
- Tests: 107/107 native-server (was 55 pre-Phase-1a; +52 from session-meta + reload-context + register-tools updates + 4 RFC §7.2 integration scenarios). 491/491 chrome-extension (unchanged from v1.7.4).

### Notes

- Direction C (bridge actively closes SSE on reload) NOT included in this release. D (soft degradation) does not depend on Codex client behavior and works regardless; C is future-work tracked separately.
- Wire protocol change is backward compatible: heartbeat body adds optional `ownerId`. Old extensions (no ownerId) continue to work; new extensions (with ownerId) get proper reload detection.

## [v1.8.0] - 2026-08-01

### Added

- **web-editor-v2 Token Pill binding (Phase 5.3 of attr-ui-refactor)** - When a property CSS value is ar(--xxx), swap the numeric/slider input for a clickable pill that opens a TokenPicker. Hover shows a clear (x) button to detach the var() reference and fall back to the computed value. Wired into the 5 main length/value controls (size, spacing, position, layout, appearance). New helper module controls/token-value-helper.ts exposes createTokenValueDisplay({ valueHolders, ariaLabel, tokensService, tokenKind, onTokenSelected, onTokenCleared }) so each control can decide its own TransactionManager pipeline (CSS var write vs inline detach). Token kind filter for the picker dropdown: length for size/spacing/position, ll for z-index/opacity. Existing pill component components/token-pill.ts (Phase 5.0) reused; picker dropdown reuses controls/token-picker.ts. property-panel.ts passes okensService through to all 5 controls. 5 vitest unit tests covering syncValue mode toggle, callback forwarding, dispose teardown. Full vitest suite: 491/491 (40 files, +5 from Phase 5.3 wiring), no regression. References: ttr-ui-refactor.md section 5.3.

## [v1.7.1] - 2026-08-01

### Fixed

- **native-messaging host stdout pollution (root cause of the Connected, Service Not Started regression)**
  - Three `console.log` calls reachable from the native-messaging host child path were writing plain text to stdout, corrupting Chrome length-prefixed JSON frame stream. Chrome read the leading bytes (`[bri` = `0x5b627269`, ~1.5 GB) as a length header, saw it as invalid, and tore down the host child immediately. Every host child died within ~1s with `Exit code: 0`, stderr 0 bytes, port 12306 never bound, and the extension popup stuck on Connected, Service Not Started forever. All three sites routed to `process.stderr` (which `run_host.bat` redirects to `native_host_stderr_*.log`):
    - `app/native-server/src/server/index.ts:598` - `[bridge] new epoch: <uuid>` log in `Server.start()`. Runs synchronously before the first `SERVER_STARTED` frame; corrupts every startup. Commit `ecbd800`.
    - `app/native-server/src/native-messaging-host.ts:395` - `Connection closed; bridge shutting down.` log in `cleanup()`. Fires on stdin EOF during normal reload exit. Commit `ecbd800`.
    - `app/native-server/src/server/index.ts:506` - `extension registered: id=...` log in the `/internal/register` HTTP handler. After the first register, any subsequent `sendMessage` (pong, future tool push) reaches Chrome with a corrupted length header, causing the host child to be torn down mid-session and producing a reconnect storm where `scheduleReconnect` spawned a fresh host child every ~5s. Commit `ef8dab1`.
  - **`processAvailable` FIFO ordering** - `setupMessageHandling` called `this.handleMessage(message)` without `.catch()`. `handleMessage` is async (it can `await startServer`), so a synchronous `sendMessage` inside it (e.g. `pong_to_extension` reply for a ping) could reach stdout before the pending async `SERVER_STARTED` frame finished. Chrome parser is order-tolerant, but the contract should be honest and end-to-end test/debug tooling depends on FIFO ordering. Now awaited with a structured `ERROR_FROM_NATIVE_HOST` frame on rejection so errors do not pollute the protocol stream. Commit `ef8dab1`.
  - **`docs/wiki/extension-reload.md` Codex auto-reinit claim** - Previously stated Codex re-initializes automatically on 400 via the bridge HTTP retry. Empirically false: the Codex desktop MCP transport closes on extension reload and does not auto-reconnect, so state-changing tool calls return `SESSION_EXPIRED` (Plan 1.4 semantic error) until Codex is restarted. Replaced with an accurate read-only vs state-changing split so the next handoff does not waste time believing the old claim.

Verified with a Python harness that emulates Chrome `connectNative`:

- spawn host child + START + ping
- stdout frames in FIFO order: `server_started`, `pong_to_extension`
- host child stays alive after 4s, stderr empty, clean exit 0 on stdin EOF
- `/health` returns 200 with new `bridgeInstanceId` per process start

Tests: Jest 53/53 (app/native-server) + Python 95/95 (tools/) still green. Popup flips from Connected, Service Not Started to Service Running (HTTP 12306) after reload; `/health` returns `extension.heartbeatAgeMs` ticking down every 60s.

## [v1.7.0] - 2026-08-01

### Added

- **chatgpt_consult flush polish** (Step 3 follow-up, observability fix).
  tools/chatgpt_consult.py 4 print() calls (consult done/reply/handoff +
  capture captured) now use `flush=True` to prevent stdout buffer loss when the
  process is killed by SIGTERM / shell timeout. FATAL stderr print unchanged
  (stderr unbuffered by default). Discovered during Step 3 e2e smoke test
  where chatgpt_consult.py actually completed in <30s but stdout never appeared
  before 180s shell timeout — making it look like the process was stuck.
  Commit: 9bf67fe (work/zamelee-bootstrap). Tests: Python 95/95 (no regression).
- **chatgpt_consult refactor as thin CLI wrapper** (Step 3 / Patch 6 follow-up).
  tools/chatgpt_consult.py collapsed from 378 lines self-contained to 151 lines
  CLI wrapper. All vendor-specific logic (ProseMirror composer, Continue generating
  auto-click, dynamic stable threshold, sha1 injection verify, MCP transport wiring)
  now lives ONLY in tools/chatgpt_controller.py (subclass of Patch 6 VendorControllerBase).
  The CLI surface keeps argparse + bundle merge (Patch 5) + ai-conversations.json
  append (--register) + delegation to controller.consult() / .capture().
  tools/chatgpt_controller.py gains capture(url, tab_id, topic) reusing the
  VendorControllerBase.consult() orchestrator pattern (read-only, no prompt injection).
  tools/test_chatgpt_consult.py rewritten: 9 new CLI delegation tests replace 7
  legacy function tests (legacy functions were removed). tools/test_chatgpt_consult_use_controller.py
  deleted (--use-controller flag removed — controller is now default path).
  Full Python suite: 95/95 (bundles 30 + chatgpt_consult 9 + selectors 24 + vendor_base 32).
  Native jest suite: 35/35 (Patch 1 popup-gate + Patch 3 browser-config unchanged).
  E2E smoke verified: Codex → MCP bridge → real Chrome → chatgpt.com (logged-in LEE) →
  ChatGPT reply "smoke-ok-2026-08-01" + "cli-wrapper-ok-2026-08-01" (sha1 norm 严丝合缝).
  Commit: 48e8982 (work/zamelee-bootstrap). Closes Patch 6 architecture loop.
  Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md section 3.
- **Per-vendor controller base class** (Patch 6 of 6 from agentify-sh/desktop deep-dive).
  New tools/vendor_base.py (~280 lines) provides VendorControllerBase ABC with 6
  abstract methods (_vendor_name / _get_allowed_host / _build_reply_selector /
  _fetch_and_inject_prompt / _click_send / _wait_for_assistant_stable) + 2 optional
  hooks (_post_extract_hook / _challenge_markers). Shared infrastructure includes
  Mutex.runExclusive (per-tab single-flight), StopToken (cooperative cancel chain
  raising CancelledError), ChallengeDetector (vendor-customized anti-bot probe),
  MCP transport (post / parse_sse / js_evaluate / chrome_navigate / chrome_computer /
  chrome_extract), and _save_handoff (markdown write). Two shipped subclasses:
  ChatGPTController (ProseMirror composer + Continue generating auto-click) and
  CopilotController (textarea + Enter + single-shot response). Test matrix: 32 cases
  in tools/test_vendor_base.py (all green). Full Python suite: 93/93 across 4 files
  (chatgpt_consult 7 + selectors 24 + bundles 30 + vendor_base 32, no regression).
  Final patch of agentify-sh/desktop deep-dive plan (6/6 complete).
  Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md section 2.6.
- **Bundle concept landed** (Patch 5 of 6 from agentify-sh/desktop deep-dive).
  New tools/bundles.py (172 lines) exposes load_bundle / list_bundles /
  normalize_bundle / merge_bundle_with_args / reset_cache. New prompts/bundles/
  directory ships 2 example bundles (repo-review.json, architecture-doc.json) +
  AGENTS.md authoring guide. Bundle schema enforces: name 1-120 chars matching
  ^[A-Za-z0-9._-]+$, attachments/contextPaths must be absolute paths, all strings
  non-empty after strip. chatgpt_consult.py gains --bundle NAME / --prompt-prefix /
  --attachment / --context-path flags. Bundle not found exits with code 8 (HTTP 404
  semantics per plan section 2.5). Test matrix: 30 cases in tools/test_bundles.py
  (all green). Full Python suite: 61/61 (no regression).
  Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md section 2.5.
- **selectors.json multi-selector fallback** (Patch 4 of 6 from agentify-sh/desktop deep-dive).
  New tools/selectors.json defines 5 required elements (promptTextarea, sendButton,
  stopButton, assistantMessage, composerRoot) with 5-13 fallback CSS selectors each
  (13/11/6/8/5 respectively, totaling 43 fallbacks). tools/selectors.py exposes
  load_selectors() + validate_selectors() + get_selector() + get_primary_fallback()
  - compose_message_selector() with override path support (~/.codex/selectors.override.json).
    tools/chatgpt_consult.py REPLY_SELECTOR migrated to use compose_message_selector(),
    keeping the legacy hardcoded format as a chr()-based fallback when running outside
    tools/. Test matrix: 24 cases in tools/test_selectors.py (all green) + 7/7 from
    Patch 2 (no regression).
    Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md section 2.4.
- **findChromeExecutable port** (Patch 3 of 6 from agentify-sh/desktop deep-dive).
  app/native-server/src/scripts/browser-config.ts extends BrowserType enum with
  BRAVE / EDGE (in addition to CHROME / CHROMIUM). Adds 3 new exports:
  resolveBrowserExecutable(browser) returns the first existing candidate path
  (Windows: 3 ProgramFiles + 3 ProgramFiles(x86) + LOCALAPPDATA variants;
  macOS: /Applications/_.app/Contents/MacOS/_; Linux: /usr/bin/*); findChromeExecutable(explicitPath?)
  with explicit-path short-circuit + priority chain (Chrome > Chromium > Brave > Edge)
  - PATH fallback via where/which; chromeSpawnOptions(platform?) returns
    {detached:true, stdio:'ignore', windowsHide:true} on Windows (per agentify-sh
    v0.2.4 regression fix). Throws ChromeBinaryNotFoundError with searchedPaths
    for diagnostics. Test matrix: 15 cases in browser-config.test.ts (all green).
    Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md section 2.3.
- **chatgpt_consult waitForAssistantStable** (Patch 2 of 6 from agentify-sh/desktop deep-dive).
  tools/chatgpt_consult.py upgrades wait_for_response with dynamic text-stable
  threshold (1500/2200/3000 ms by length) + Continue generating button auto-click
  (max 3). Adds extract_code_blocks(sid, tab_id) returning [{language, text}].
  extract_reply returns 3-tuple (page_url, text, code_blocks); consult() and
  capture_only() pass code_blocks through to save_handoff. save_handoff writes
  a 4th handoff section when code_blocks present, with `lang fenced blocks.
  Test matrix: 7 cases in tools/test_chatgpt_consult.py (all green).
  Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md.
- **popup-gate policy module** (Patch 1 of 6 from agentify-sh/desktop deep-dive).
  New pp/native-server/src/server/popup-gate.ts gates browser popup URLs
  against a vendor-aware SSO allowlist (chatgpt / claude / gemini / perplexity /
  grok / aistudio). Handles the bout:blank OAuth pre-open special case.
  Adapted from upstream popup-policy.mjs (MPL-2.0, v0.2.4).
  Exposed via NativeMessagingHost.evaluatePopupGate(input) so the Chrome
  extension background script can call it before allowing OAuth popups to open.
  Test matrix: 13 cases in popup-gate.test.ts (all green).
  Plan + context: plans/2026-07-30-agentify-sh-deep-dive-patch-plan.md.

### Fixed

- **native-server test build infra** — sconfig.json adds isolatedModules: true
  and jest.config.js adds a moduleNameMapper that rewrites NodeNext ESM-style
  .js import specifiers to .ts at resolution time, plus pins ts-jest to
  CommonJS at test time. Without these, src/server/server.test.ts cannot
  resolve ../constant/index.js (no build artifact emitted) and the whole
  server test file silently fails to load. Caught while integrating Patch 1.

- **chatgpt SSO 403 cascade** — when chatgpt.com opens a Google/Microsoft/GitHub
  OAuth popup and the Chrome extension blocks it, the chatgpt backend falls back
  to embedded login, the React tree corrupts, and the next conversation call
  returns 403 + _ref is not defined page crash. popup-gate lets the extension
  recognize vendor SSO providers and allow those popups through.

## [v1.6.1] - 2026-07-24

### Fixed

- **output-sanitizer 精简与修复** — 移除 `sanitizeOutput` 中的冗余分支逻辑，简化代码结构。
- 新增 `output-sanitizer.test.ts` 单元测试覆盖。

### Changed

- 所有包版本统一为 v1.6.1。

## [v1.6.0] - 2026-07-24

### Added

- **猫娘毛玻璃 UI** — 扩展弹窗和 Builder 界面全面采用毛玻璃视觉效果，配合柔和猫娘主题色调。
- **品牌更名** — 项目视觉标识统一更新。
- **页面录制快捷键** — `Ctrl+Shift+1/2/3` 分别控制开始/暂停/停止录制。
- **内嵌 Shared Runtime** — native-server postinstall 自动安装 bundled shared runtime，减少手动构建步骤。
- **页面录制器新架构** — 新增 `page-recorder.ts`、`page-picker.ts`、`tabs.test.ts`。

### Changed

- **启动脚本优化** — `start-server.bat` / `start-server-npm.bat` 从 4 步精简为 3 步，移除独立 shared build 步骤。
- **错误日志系统重构** — 错误日志从行内展示改为弹窗 Modal，提升查看体验；新增网络捕获 URL 安全检查。
- **Builder/Popup UI 重构** — 大幅重写 `App.vue`，优化工作流编辑器界面。
- **导航容错增强** — 页面导航失败时提供更清晰的错误回退。
- **依赖升级** — pnpm 从 11.15.1 升级至 11.17.0。

### Fixed

- **Native Messaging 注册容错** — 检测到 `EPERM` 时给出明确提示，建议关闭 Chrome 后重试。

- 所有包版本统一为 v1.6.0。

## [v1.5.3] - 2026-07-21

### Fixed

- **可靠滚动容器识别**: `chrome_scroll` 和 `chrome_get_scroll_state` 使用同一真实容器解析，修复虚拟列表上回执成功但未移动的问题。

### Added

- `anchorSelector` 参数可将自动识别锁定到嵌套或虚拟列表中的内容锚点。
- 滚动结果新增目标容器和实际位移回执。
- 所有发布包版本统一为 v1.5.3。

## [v1.5.2] - 2026-07-21

### Added

- **操作意图显示**: 在浏览器状态叠加层显示当前步骤的 `intent` 信息，AI 执行时用户可清晰了解每一步的意图。
  - 🏷️ 所有工具输入新增可选 `intent` 字段
  - 🖥️ 状态叠加层 (`chrome_operation_status`) 显示"意图：xxx"行
  - 🔄 自动截断长意图文本至 160 字符

### Changed

- **类型安全增强**: 模型选择接口从 `string` 迁移至 `ModelPreset` 枚举，消除运行时类型风险。
- **预览元数据结构优化**: `AgentSessionListItem` 中预览元数据解析逻辑重构，增强 `WebEditorApply` 类型的健壮性。
- 所有包版本统一为 v1.5.2

## [v1.5.1] - 2026-07-19

### Added

- **元素代码生成弹窗**: 标记元素后弹窗展示定位代码，替代原有 JSON 文件导出。
  - 🪟 内联代码弹窗 UI，支持一键复制到剪贴板
  - 🌐 支持 JavaScript（querySelector / XPath）和 Python（Selenium By）两种代码格式
  - 📋 使用 Clipboard API + fallback 兼容，确保所有环境下可用
  - ⌨️ Escape 键快捷关闭弹窗
  - 📑 代码标签页切换（JS / Python），复制按钮标题跟随语言同步更新

### Changed

- 所有包版本统一为 v1.5.1

## [v1.5.0] - 2026-07-19

### Breaking

- **工作流引擎 v3 架构统一**: 旧版 record-replay v2 代码已全面迁移至 v3 统一架构。
  - 🧹 移除 v2 旧引擎、旧录制模块、旧节点系统（共 50+ 文件）
  - 🏗️ 动作处理器统一为 `record-replay-v3/actions` 模块
  - 🔌 插件系统重构为 `action-node-adapter` + `register-action-nodes`
  - 📦 新增 `public-api` / `builder-types` / `utils` 公共模块
  - 📉 净减少 ~12,300 行旧代码
  - 📦 v1.5.0 之前的旧版本源码已归档至 `V2toV3` 分支

### Changed

- 所有包版本统一为 v1.5.0

## [v1.4.0] - 2026-07-18

### Added

- **Catgirl assistant persona**: Claude and Codex sessions now use a warm, professional catgirl personality while preserving reliable tool execution.
- **DeepSeek API engine**: OpenAI-compatible streaming chat support via `DEEPSEEK_API_KEY`.
- **Assistant and quick-tool guides**: Added bilingual setup and usage documentation.

### Changed

- **Node 24 SQLite compatibility**: Upgraded `better-sqlite3` to v12 for a compatible native binary.
- **pnpm**: Project now pins pnpm 11.14.0 through Corepack; the root build command works correctly in PowerShell.
- **DeepSeek settings**: API Key and optional Base URL can be set in the extension without returning the key to the UI.

## [v1.3.3] - 2026-07-17

### Added

- **CDP image blocking**: `chrome_block_images` stops future image requests before navigation or reload.

## [v1.3.2] - 2026-07-17

### Fixed

- Content scripts no longer register `unload` listeners, avoiding Permissions Policy errors.
- Startup scripts warn when Chrome locks `app/native-server/dist` during a rebuild.

### Changed

- Operation overlay now shows the target, wait limit, selection range, and expanded/collapsed element name when available.

## [v1.3.1] - 2026-07-16

### Added

- **Operation overlay**: Show the current MCP action in the page bottom-left and highlight its target when available.

### Changed

- Lazy-load scrolling now returns after a paced step so it can be repeated without exceeding short MCP request limits.

## [v1.3.0] - 2026-07-16

### Added

- **CLI `start` command**: New `cli.js start` subcommand to launch the Native Host directly.
- **Auto-derive extension ID**: Native Messaging registration now reads the extension ID from the current Chrome build instead of hard-coding it.
- **Port conflict resolution**: `start-server.bat` and `start-server-npm.bat` automatically kill any existing process on port 12306 before starting.
- **`reasonix.toml`**: Project configuration file for Reasonix agent.
- **`start-server-npm.bat`**: npm-based one-click startup script (alternative to pnpm version).
- **Pop-up UI beautification**: Status banner with colored background, enlarged status dot with glow, SVG warning icon, port input with `127.0.0.1:` prefix, visual grouping of connection controls.
- **Extension ID display**: Pop-up now shows the runtime extension ID and current extension logo.
- **Semantic engine cleanup**: Unused agent-model configurations removed.

### Changed

- Extension icons compressed significantly (e.g. 128.png: 210 KB → 33 KB).
- All release packages bumped to v1.3.0.
- `start-server.bat` now runs `pnpm install` and uses `cli.js start` instead of `dist/index.js`.

### Removed

- `app/native-server/start-server.js`: Superseded by `cli.js start`.

## [v1.2.1] - 2026-07-15

### Added

- **Tool cancellation**: `CANCEL_TOOL` message type for aborting in-flight tool calls. AbortController support in native host and Chrome extension.
- **`stableForMs` for `chrome_wait`**: Require the condition to remain true continuously for N milliseconds before returning (default: 0).
- **`expectedUrl` URL guard**: Write tools (navigate, click, fill, scroll, click_and_wait) accept `expectedUrl` — refuses execution if the target tab URL doesn't match.
- **Active tab resolution**: Write operations auto-resolve the active tab ID before execution.
- **Tool-level dynamic timeouts**: Timeouts tailored per tool type (write/read/navigation/long-running).
- **Per-tab serialization**: Write operations to the same tab are queued sequentially.
- **`getRecentToolCalls()`**: Diagnostic endpoint logging recent tool activity (outcome, timing, errors).

### Changed

- All release packages bumped to v1.2.1.
- `/status` endpoint enhanced with MCP session tracking (`activeSessions`, `activeRequests`, `reclaimedSessions`), NativeHost connection state, and optional `probe` query parameter for end-to-end health check.
- Stale MCP sessions (>10 min idle) are automatically reclaimed every 60s.
- `start-server.bat` version label updated.

### Fixed

- Server test: Added GET /status smoke test.

## [v1.2.0] - 2026-07-15

### Added

- `/status` reports service, MCP session, Native Messaging, extension, and tool availability.
- Per-tab serialization for browser write operations, MCP cancellation forwarding, and stale-session reclamation.
- `stableForMs` for `chrome_wait`.
- `start-server.bat`: One-click startup script for local Native Host.

### Changed

- All release packages bumped to v1.2.0.
- README.md / README_en.md: Professional rewrite with consistent bilingual structure.
- docs/TOOLS_zh.md: Added complete scraping tools documentation (v1.1.0 + v1.1.2 tools).

### Fixed

- Native server: Removed module-level `mcpServer` singleton to avoid state leaks.

## [v1.1.2] - 2026-07-15

### Added

- `chrome_get_page_text`: Extract readable article text, HTML, and metadata with Readability.
- Same-origin iframe support (`frameSelector`) for `chrome_scroll`, `chrome_wait`, and `chrome_extract`.
- `table` extraction mode in `chrome_extract`, including `colspan` and `rowspan` expansion.
- `chrome_click_and_wait`: Click an element, then wait for a target element state.

### Changed

- All release packages bumped to v1.1.2.

## [v1.1.1]

### Fixed

- **Extension ID Calculation**: Fixed incorrect extension ID in native host constant — was using a manually guessed ID, now computes correctly from the extension key. Native messaging connection now works.
- **Extension ID Stability**: Fixed Chrome extension key in `.env.local` so the extension ID no longer changes on reload
- **Native Messaging Registration**: Updated native host manifest with correct extension ID

### Changed

- All packages bumped to v1.1.1

## [v1.1.0]

### Added

- **4 Scraping Tools**: New MCP tools for web scraping and data collection
  - `chrome_get_tab_url`: Lightweight tab URL retrieval (faster than `get_windows_and_tabs`)
  - `chrome_scroll`: Scroll page/container with 4 modes (pixel/edge/element/container auto-detect)
  - `chrome_wait`: Wait for element or JS condition with 6 wait modes (visible/present/hidden/gone/enabled/jsCondition)
  - `chrome_extract`: Extract structured data via CSS selectors with 7 extraction types (text/html/outerHtml/attribute/number/href/src)

## [v0.0.5]

### Improved

- **Image Compression**: Compress base64 images when using screenshot tool
- **Interactive Elements Detection Optimization**: Enhanced interactive elements detection tool with expanded search scope, now supports finding interactive div elements

## [v0.0.4]

### Added

- **STDIO Connection Support**: Added support for connecting to the MCP server via standard input/output (stdio) method
- **Console Output Capture Tool**: New `chrome_console` tool for capturing browser console output

## [v0.0.3]

### Added

- **Inject script tool**: For injecting content scripts into web page
- **Send command to inject script tool**: For sending commands to the injected script

## [v0.0.2]

### Added

- **Conditional Semantic Engine Initialization**: Smart cache-based initialization that only loads models when cached versions are available
- **Enhanced Model Cache Management**: Comprehensive cache management system with automatic cleanup and size limits
- **Windows Platform Compatibility**: Full support for Windows Chrome Native Messaging with registry-based manifest detection
- **Cache Statistics and Manual Management**: User interface for viewing cache stats and manual cache cleanup
- **Concurrent Initialization Protection**: Prevents duplicate initialization attempts across components

### Improved

- **Startup Performance**: Dramatically reduced startup time when no model cache exists (from ~3s to ~0.5s)
- **Memory Usage**: Optimized memory consumption through on-demand model loading
- **Cache Expiration Logic**: Intelligent cache expiration (14 days) with automatic cleanup
- **Error Handling**: Enhanced error handling for model initialization failures
- **Component Coordination**: Simplified initialization flow between semantic engine and content indexer

### Fixed

- **Windows Native Host Issues**: Resolved Node.js environment conflicts with multiple NVM installations
- **Race Condition Prevention**: Eliminated concurrent initialization attempts that could cause conflicts
- **Cache Size Management**: Automatic cleanup when cache exceeds 500MB limit
- **Model Download Optimization**: Prevents unnecessary model downloads during plugin startup

### Technical Improvements

- **ModelCacheManager**: Added `isModelCached()` and `hasAnyValidCache()` methods for cache detection
- **SemanticSimilarityEngine**: Added cache checking functions and conditional initialization logic
- **Background Script**: Implemented smart initialization based on cache availability
- **VectorSearchTool**: Simplified to passive initialization model
- **ContentIndexer**: Enhanced with semantic engine readiness checks

### Documentation

- Added comprehensive conditional initialization documentation
- Updated cache management system documentation
- Created troubleshooting guides for Windows platform issues

## [v0.0.1]

### Added

- **Core Browser Tools**: Complete set of browser automation tools for web interaction

  - **Click Tool**: Intelligent element clicking with coordinate and selector support
  - **Fill Tool**: Form filling with text input and selection capabilities
  - **Screenshot Tool**: Full page and element-specific screenshot capture
  - **Navigation Tools**: URL navigation and page interaction utilities
  - **Keyboard Tool**: Keyboard input simulation and hotkey support

- **Vector Search Engine**: Advanced semantic search capabilities

  - **Content Indexing**: Automatic indexing of browser tab content
  - **Semantic Similarity**: AI-powered text similarity matching
  - **Vector Database**: Efficient storage and retrieval of embeddings
  - **Multi-language Support**: Comprehensive multilingual text processing

- **Native Host Integration**: Seamless communication with external applications

  - **Chrome Native Messaging**: Bidirectional communication channel
  - **Cross-platform Support**: Windows, macOS, and Linux compatibility
  - **Message Protocol**: Structured messaging system for tool execution

- **AI Model Integration**: State-of-the-art language models for semantic processing

  - **Transformer Models**: Support for multiple pre-trained models
  - **ONNX Runtime**: Optimized model inference with WebAssembly
  - **Model Management**: Dynamic model loading and switching
  - **Performance Optimization**: SIMD acceleration and memory pooling

- **User Interface**: Intuitive popup interface for extension management
  - **Model Selection**: Easy switching between different AI models
  - **Status Monitoring**: Real-time initialization and download progress
  - **Settings Management**: User preferences and configuration options
  - **Cache Management**: Visual cache statistics and cleanup controls

### Technical Foundation

- **Extension Architecture**: Robust Chrome extension with background scripts and content injection
- **Worker-based Processing**: Offscreen document for heavy computational tasks
- **Memory Management**: LRU caching and efficient resource utilization
- **Error Handling**: Comprehensive error reporting and recovery mechanisms
- **TypeScript Implementation**: Full type safety and modern JavaScript features

### Initial Features

- Multi-tab content analysis and search
- Real-time semantic similarity computation
- Automated web page interaction
- Cross-platform native messaging
- Extensible tool framework for future enhancements
