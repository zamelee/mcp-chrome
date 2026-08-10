## [v1.10.3] - 2026-08-10

### Documentation

- **§0a.x.9 Cross-Vendor Dedup Decision Table** (痛点: v1.10.0 patch 修了 chatgpt/copilot/gemini 三家 dedup detection 但 AGENTS.md 缺决策表; LLM 落地时容易选错 selector / keyword / fallback)。

  改动:
  - 在用户全局 `~/.codex/AGENTS.md` 新增 §0a.x.9 + §0a.x.9.0-7 (insertion point: line 480, before §0b.7; backup `~/.codex/AGENTS-backups/AGENTS.md.bak-clean-20260810-105932` + `AGENTS.md.bak-pre-v1103-section-xa-x9-20260810-112532`)。
  - §0a.x.9.0 Quick Decision Summary: 5 行 runbook (Agent 第一眼看的快速判断)。
  - §0a.x.9.1 Dedup Keyword 矩阵: 9 regex × 3 vendor × selector × accept × UI surface × match keywords。
  - §0a.x.9.2 Verdict Decision Table: 5 status (succeeded / rejected / dialog_blocked / uncertain / probe_failed) + trigger + UI signal + agent action；明确 uncertain vs probe_failed 区别 (chatgpt review 要求)。
  - §0a.x.9.3 Decision Tree: 7 行覆盖 800/2000/4000 chars 分界 + 双附件 + vendor-specific 路径。
  - §0a.x.9.4 Instrumentation Noise: 5 chatgpt 专属 regex + isRealError() flow。
  - §0a.x.9.5 反例 / 教训: 8 行覆盖 v1.10.0 + 2026-08-10 实测坑 (含 dedup 不要循环 miss + chatgpt modal lock 三层结构)。
  - §0a.x.9.6 chatgpt Modal Lock 三层结构 (2026-08-10 生产事故案例): dialog + backdrop-blur overlay + body scroll-lock; unlock JS 三件套。
  - §0a.x.9.7 维护规则 (when to update this table): 新 vendor / regex 变更 / 新 status / production 事故 4 个 trigger。

- **Handoff correction** (痛点: 之前 handoff 描述 "pre-existing 7 TS errors"，实际 v1.10.x 发布前已修复; 但 handoff 描述未更新, 后续会话误以为 7 个 error 还在)。

  改动:
  - `docs/handoff/2026-08-05-three-line-integration.md` 纳入版本 (从 untracked → git add)。
  - 新增 `docs/handoff/RESOLVED.md` 记录 TS errors resolved history:
    - `bridge-control.ts` 5 errors: previously reported errors are no longer reproducible; fix commit not isolated (likely during/after `161a7e6 Plan 2.1 + 2.2` rewrite; no standalone fix commit identified)。
    - `performance.ts` 2 errors: 同上 (likely during/after `eef5d9f` 引入 cycle; no standalone fix commit)。
    - 当前实测 `pnpm -r exec tsc --noEmit` 返 0 errors (verified 2026-08-10)。
  - 加 "如何避免旧 claim 重复误导" 段 (§4 of RESOLVED.md)。

- **CHANGELOG alignment** (痛点: v1.10.0-2 三个 patch 加完, 但 §0a.x.9 table 缺失文档化)。

  改动:
  - 本 entry 记录 §0a.x.9 patch + handoff correction + commit `v1.10.3` tag。

### Notes

- §0a.x.9 patch 纯文档增量, 不动运行代码, 0 风险。
- handoff correction 文档增量 + untracked → tracked 转换, 0 风险。
- 测试基线保持: chrome-extension 543/543, native-server 108/108, TS 0 errors。
- v1.10.3 不依赖 v1.10.4 / v1.10.5, 可单独 ship。
- chatgpt review (1939 chars, https://chatgpt.com/c/6a793c18-...) 已归档到 `tmp/_chatgpt_review_v1103_drafts.md` (4 段: accuracy / missing / unclear wording / style consistency)。
- Copilot engineering review attempt 失败 (React controlled textarea JS-set value 不触发 Ask button click)；chatgpt 综合评审已足够覆盖，跳过。## [v1.10.2] - 2026-08-07

### Added

- **Chrome toolbar icon 状态机 (8-state IconManager)** (痛点: 之前 toolbar icon 永远是同一张静态图, 用户看不出扩展健康状态; 现在 8 状态 + 优先级 + sticky-error + throttle coalesce + badge text)。

  改动:
  - 新增 `entrypoints/background/icon-manager.ts` (155 行): 8 IconState (READY / SERVICE_DOWN / DISCONNECTED_AUTO / DISCONNECTED_MANUAL / ERROR / BUSY / STALE / CODEX_IDLE) + 优先级 (1-8) + sticky ERROR 5s lock + 250ms throttle + setBadgeText/setBadgeBackgroundColor + IconState path 生成 (`icons/<state>/{16,32,48}.png`)。
  - 新增 `public/icons/` 下 8 套 (24 个 PNG): 通过 PIL `tmp/_gen_icons.py` 一次性生成 (16/32/48 px, ~200-400 bytes each)。
  - 修改 `wxt.config.ts` `manifest.action.default_icon` 指向 `ready` 套 (默认状态), runtime 由 icon-manager 切换其他 7 套。
  - `bridge-control.ts`: `onBridgeStarted` set READY; `onBridgeStopped` set DISCONNECTED_AUTO + clear READY/BUSY。
  - `native-host.ts`: `call_tool` 入口 set BUSY (开始) -> clear BUSY (完成) / set ERROR (失败); `ERROR_FROM_NATIVE_HOST` set ERROR。

  设计:
  - 优先级: ERROR (8) > BUSY (7) > STALE (6) > SERVICE_DOWN (5) > DISCONNECTED_MANUAL (4) > DISCONNECTED_AUTO (3) > CODEX_IDLE (2) > READY (1)。
  - sticky ERROR: 一旦触发, 锁 5s 防止后续 READY heartbeat 立即覆盖。
  - throttle 250ms: 多次状态更新在同一 tick 合并为 1 次 setIcon。
  - badge text 上限: 按 chrome 文档 <=4 chars (用 `!`/`X`/`E`/`?`/`*`/`0`/`...`)。

  验证: chrome-extension vitest 532 -> **543** (+11 new icon-manager tests: priority order / ERROR sticky / BUSY/RESET / clear semantics / throttle coalesce / badge text + bg color); native-server 108/108 unchanged; pnpm build OK; manifest default_icon 包含 ready 套。

### Notes

- chatgpt "dynamic loading chrome.action icon 时不能画图, 必须预生成" 限制严格遵守 - 8 套 PNG 在 build-time 生成。
- icon-manager 是 module-level singleton, 跟 monitor 一样靠 debounced/coalesced update 避免高频 churn。
- pre-existing bridge-control.ts 类型错误未在本 patch 修复 (已知遗留)。

## [v1.10.1] - 2026-08-07

### Added

- **Popup 双工通讯监控面板 (MessageFlow)** (痛点: 之前 popup 只能看 isRunning / port / lastUpdated, 看不出 message flow 是否正常; debug 要打开 chrome://extensions > service worker console 才能看到 native-host stderr log, 反馈路径太长)。

  改动:
  - 新增 `entrypoints/background/monitor.ts` (168 行): 200 条 ring buffer + chrome.storage.session 持久化 (debounced 500ms) + subscribe 模式 + safeSummary (敏感字段 redaction + 80 字符截断) + severity 分类 (info / warn / error)。
  - 新增 `popup/components/MessageFlow.vue` (160 行): 折叠面板 (默认 IN/OUT/ERR/total 计数器) + 展开视图 (时间戳 + 方向箭头 + layer pill + type + redacted summary) + 清空按钮。500ms poll 拉 storage, 不阻塞 message flow。
  - 在 `native-host.ts` 加 3 处 `recordMessage()`: (1) `nativePort.onMessage` 入站 (2) `nativePort.postMessage(START)` 出站 (3) `chrome.runtime.onMessage` popup->background 入站。
  - 在 `native-host.ts` 的 `chrome.runtime.sendMessage` broadcast 处加 1 处 `recordMessage()`: file_operation_response 出站。
  - `common/constants.ts` 加 `STORAGE_KEYS.MESSAGE_BUFFER` 常量。
  - `App.vue` 在 rescue section 之后 + MCP config section 之前嵌入 `<MessageFlow />`。

  性能: message 流不经过 popup, popup 只是 observer; debounced 500ms storage write 避免 IO burst; safeSummary 自动 redact `token` / `cookie` / `password` / `bearer` / `secret` 字段 (避免 console 暴露敏感数据)。

  验证: chrome-extension vitest 518 -> **532** (+14 new monitor tests: safeSummary / classifySeverity / ring buffer eviction / subscriber / persistence debounce / hydrateFromStorage / clear / aggregate); native-server 108/108 unchanged; popup load verified (HTML grep `message-flow` 在 chunks 里可见)。

### Notes

- MessageFlow 不替换现有 `error-log-modal` (那是 errors-only UI) — 共存, 错误事件同时出现在两处。
- popup 是 MV3 popup (close 即销毁), onUnmounted 正确清理 monitor subscription + interval。
- v1.10.0 引入的 `dialog_blocked` postcondition status 跟 monitor 是独立两条线 — 一个是 upload 上传结果判定, 一个是运行时 message flow 监控。

## [v1.10.0] - 2026-08-07

### Fixed

- **chrome_upload_file `verifyPostcondition` 三 bug 修复** (痛点: agent 无法稳定判断 chatgpt.com / github.com/copilot / gemini.google.com 的真实上传结果)。

  根因 (v1.9.5 设计的盲区):
  - **Bug 1 (判定顺序)**: `if (!allMatched) return uncertain` 先于 errors 检查 → github.com/copilot 后端拒收后清空 fileInput → allMatched=false → 直接走 uncertain → 应该 rejected 的被判成 uncertain。
  - **Bug 2 (误判)**: chatgpt.com 在 `role="alert"` 节点里嵌入 instrumentation script (`__oai_logHTML`, `__oai_SSR_*`, `requestAnimationFrame`, inline `addEventListener` lambda) → 整段 textContent 被收集进 `newErrors` → `errorsMentionFile` 匹配到 filename → 误判 rejected (实际 upload 成功)。
  - **Bug 3 (dedup dialog 不检测)**: chatgpt.com per-account dedup 弹 `role="dialog"` 含 "already uploaded this file" → 完全没被探针扫到 → 既不是 succeeded 也不是 rejected 或 dedup 标记。

  修法 (3 处加 1 status):
  - 加 module-level `DEDUP_KEYWORDS` (chatgpt/copilot/gemini 多 vendor 关键字) + `INSTRUMENTATION_NOISE` (chatgpt 噪音模式) + `isRealError()` / `extractDedupKeyword()` 辅助函数。
  - 加 `[role="dialog"]` 节点扫描到 probe expression。
  - 判定顺序改为 **errors-first → dialog-dedup → fileInput → chip**，新增 status `'dialog_blocked'`。
  - 用 `DedupMatch` 类型 + `(d): d is DedupMatch` type-guard predicate 替代 `find()` + 后置 narrowing（更安全、可读）。

  影响范围: 仅 `app/chrome-extension/entrypoints/background/tools/browser/file-upload.ts` 1 个文件; TypeScript 编译 0 error; vitest 505 → **518** (+13 新测试)。

### Changed

- `app/chrome-extension/package.json`: 1.9.8 -> 1.10.0
- `app/native-server/package.json`: 1.9.8 -> 1.10.0
- `packages/shared/package.json`: 1.9.8 -> 1.10.0
- `package.json`: 1.9.8 -> 1.10.0 (governance infra)

### Tests

- chrome-extension: **518/518** pass (+13 new: 6 helper coverage + 6 verdict branch logical spec + 1 Bug 2 regression guard)
- native-server: **108/108** pass (unchanged)

### Notes

- agent 拿到新 status 后怎么 fallback 写进 AGENTS.md §0a.x.9 (下一个 patch)。
- `_verifyUploadPostcondition` 仍然是 private method — 测试通过复制 regex 列表 + 复制 verdict 逻辑到 test file 实现 (mirror)。后续如要直接测 private method，需要 export 一个 thin wrapper。
- pre-existing 的 `bridge-control.ts` / `performance.ts` 类型错误不在本 patch 范围 (v1.9.x 时代遗留)，下个 patch 单独修。

## [v1.9.8] - 2026-08-07

### Fixed

- **Extend modulepreload strip from offscreen.html to ALL extension HTML entries** (v1.9.7 was too narrow). Same root cause as v1.9.7 but spans the full extension surface.

  痛点: v1.9.7 only matched `offscreen.html`, so `welcome.html` / `popup.html` / `options.html` / `sidepanel.html` / `builder.html` still emitted `<link rel="modulepreload" crossorigin>` in the HTML and still produced Console warnings:
  - `A preload for ... is found, but it is not used because it is a cross-world extension resource mismatch.`
  - `The resource ... was preloaded using link preload but not used within a few seconds from the windows load event.`

  修法: `app/chrome-extension/wxt.config.ts` 把 `mcp-chrome-strip-offscreen-preload` 改名 + 范围扩成 `mcp-chrome-strip-modulepreload`,`transformIndexHtml` 现在对每个 `.html` 结尾的 entry 都剥离 `<link rel="modulepreload">`。plugin name 改了,scope 从 `endsWith('offscreen.html')` 改成 `/\.html$/.test(filename)`,off-screen 这一个特化条件不再存在。

  影响范围: 全部 6 个 HTML 入口 (builder / offscreen / options / popup / sidepanel / welcome) — 验证后 0 个 modulepreload link 残留。Plugin 仍在 Vite `transformIndexHtml.order='post'` 钩子里跑,build-time transform,无 runtime 影响。

  设计哲学: chrome-extension:// origin 里 preload 永远不 work(Chrome 视为 cross-world 拒 CORS preflight),剥了没损失 — 既清掉 Console warning,也微减首屏 probe 时间。

### Changed

- `app/chrome-extension/package.json`: 1.9.7 -> 1.9.8
- `app/native-server/package.json`: 1.9.7 -> 1.9.8
- `packages/shared/package.json`: 1.9.7 -> 1.9.8
- `package.json`: 1.9.7 -> 1.9.8 (governance infra)

### Tests

- chrome-extension: **505/505** pass (无新增 — plugin 改动是 build-time transform,通过 build output 验证)

### Notes

- 验证方法: `cd app/chrome-extension && pnpm build` 后 `python tmp/_check_html.py`,期望 6/6 HTML 全部 OK / 0 modulepreload。Chrome reload extension 后,F12 -> Console 不再出现 `cross-world extension resource mismatch` / `preloaded using link preload but not used within a few seconds` 这两类 warning(无论哪个 HTML 入口)。
- v1.9.7 entry 保留原状 — v1.9.8 是 superset(v1.9.7 只剥 offscreen,v1.9.8 剥全部);v1.9.7 entry 不 amend,仍描述它当时的 scope。两者合并效果 = 全部 HTML 都剥。
- 后续任何 Vite plugin 改动都要 4 个 package.json + manifest 一起 bump;manifest 由 build 自动从 package.json 读,所以仅 bump 4 个 package.json + clean rebuild 即可。

## [v1.9.7] - 2026-08-07

### Fixed

- **Chrome DevTools Console preload warnings on offscreen document** (痛点: chrome-extension offscreen documents 加载后,Console 报一堆 `preload ... is found, but it is not used because it is a cross-origin resource` + `preloaded using link preload but not used within a few seconds from the windows load event`)。

  根因: Vite 默认会给 ES module chunks 输出 `<link rel="modulepreload" crossorigin>` 以启用 CORS module loading。对 HTTP/HTTPS origin 没问题,但对 `chrome-extension://` 的 offscreen document,Chrome 会先做 CORS preflight 失败,然后标记为 unused。这是 Vite 的默认行为,v1.9.5 / v1.9.6 都有,只是 offscreen.html 加载时统一暴露。

  修法: `wxt.config.ts` 加 `mcp-chrome-strip-offscreen-preload` Vite 插件,`transformIndexHtml` 钩子在 post 阶段检测 offscreen.html,剥离所有 `<link rel="modulepreload">` 标签。Offscreen document 初始化是 lazy 的(等消息),不需要 preload — 反而 preload 触发的 CORS preflight 失败让 Chrome 误报 warnings。

  影响范围: 仅 offscreen.html (5 个 HTML 入口之一)。其他 HTML (popup/options/sidepanel/welcome/builder) 保留 Vite 默认的 preload,无 regression。

### Changed

- `app/chrome-extension/package.json`: 1.9.6 -> 1.9.7
- `app/native-server/package.json`: 1.9.6 -> 1.9.7
- `packages/shared/package.json`: 1.9.6 -> 1.9.7
- `package.json`: 1.9.6 -> 1.9.7 (governance infra)

### Tests

- chrome-extension: **505/505** pass (build output transform, no runtime impact)

### Notes

- 验证方法: Chrome 加载 v1.9.7 extension 后,F12 -> Console,reload extension 后**不应**再看到 `_chrome-extension://gjdjnkapckcbblcnepfmpfdhejjdml/chunks/asyncToGenerator-...` 和 `objectSpread2-...` 相关的 4 条 preload warnings。其他入口 (popup/options/welcome/sidepanel) 仍有 preload(正常显示 + 实际使用),所以**不**应该看到它们的 preload warnings — 仅 offscreen 之前会。
- 不依赖 Vite 升级或 Rollup 配置变化 — 仅 build-time transform hook。

## [v1.9.6] - 2026-08-07

### Added

- **Popup 救援按钮 (mcp-chrome 假死恢复)** (痛点: Codex desktop MCP transport 缓存 stale sessionId 后,即使 reload extension 也无法 re_initialize; reload 之后必须 restart Codex desktop 才能恢复)。在 popup status section 加了 2 个救援按钮:
  - **Reload Extension**: `chrome.runtime.reload()` — extension 卸载重装 → native-host pipe 断 → bridge 子进程 exit → 12306 端口断开。Codex MCP transport 应该 auto-reconnect。
  - **Reset Sessions**: 通过 native-port 通知 bridge 调用 `server.forceResetSessions()` (新增),强制 close 所有 active MCP transports,然后 chrome.runtime.reload()。即使 Codex 不 auto-reconnect,broadcast 给每个 transport 的 close frame 也会触发 reconnect。

- **bridge `forceResetSessions()` public method**: 遍历 `transportsMap`,对每个 session 调 `transport.close()`,清空 map。`/status` 报告 `activeSessions: 0` + `reclaimedSessions` 递增。幂等,空 map 调用安全。

- **native-host `FORCE_RESET_SESSIONS` case**: 新增 control message 类型,extension background 转发到此 → bridge 调 `forceResetSessions()` → response 带回 reset count。

- **background `FORCE_RESET_SESSIONS` message handler**: popup 按钮触发,通过 `chrome.runtime.sendMessage` 转发给 native port,等响应后 reload extension。

### Changed

- `app/chrome-extension/package.json`: 1.9.5 -> 1.9.6
- `app/native-server/package.json`: 1.9.5 -> 1.9.6
- `packages/shared/package.json`: 1.9.5 -> 1.9.6
- `package.json`: 1.9.5 -> 1.9.6 (governance infra)

### Tests

- native-server: **108/108** pass (新增 1 个 `forceResetSessions` 测试: clears all MCP transports + 幂等性)
- chrome-extension: **505/505** pass (无新增 — 救援按钮纯 UI 改动通过 e2e 验证)

### Notes

- **设计哲学**: reload extension 是温和恢复(赌 Codex auto-reconnect),reset sessions 是强制恢复(确保 transport close 触发)。两步式按钮让用户先试简单的,失败再试重的。
- **推荐顺序**: Reload 不行就 Reset,Reset 还不救活就 restart Codex desktop。
- 已知边界: Codex desktop MCP transport 不监听 MCP `notifications/cancelled` 或 `notifications/closed`,所以即使 bridge close transports,Codex 仍可能不 re_initialize。这是 v1.10 (daemon 模式) 才能根治的问题。

## [v1.9.5] - 2026-08-05

### Fixed

- **chrome_upload_file postcondition probe (bug A)**: after CDP `setFileInputFiles`, the tool now probes the page DOM and returns `{ postcondition: { status, fileInputFiles, chipTexts, newErrors, reason } }` instead of just `{success: true}`. Distinguishes 3 states: `succeeded` (file input reflects uploaded files AND visible chips AND no errors), `rejected` (visible error references uploaded filename), `uncertain` (mixed signals). Solves the bug where agents on chatgpt.com (silent dedup) and github.com/copilot (CJK+markdown rejection with stale toast) couldn't tell whether their upload succeeded. `verifyPostcondition: false` opt-out for performance.
- **chrome_save_text tool (bug B)**: new MCP tool `chrome_save_text({ text, filePath, mimeType? })` that writes text content to disk via native-host atomic write-rename (same path as `chrome_screenshot savePath`). Bypasses Chrome download API entirely — no Save As dialog. Replaces the broken `Blob + a.click()` pattern that triggered the browser download UI (实测 2026-08-05 github copilot 抓全文时弹 Save As 弹窗).

### Changed

- `app/chrome-extension/package.json`: 1.9.4 -> 1.9.5
- `app/native-server/package.json`: 1.9.3 -> 1.9.5
- `packages/shared/package.json`: 1.8.1 -> 1.9.5
- `package.json`: 1.9.4 -> 1.9.5 (root, governance infra)

### Tests

- native-server: 107/107 pass (unchanged)
- chrome-extension: 505/505 pass (unchanged)

### Notes

- For users: nothing actionable for v1.9.5. These are quality-of-life fixes for agent reliability (the agent now sees upload status correctly and can save page content without annoying Save As dialogs). The MCP protocol is unchanged.
- For agent guidance: `~/.codex/AGENTS.md` §0b.7.7 + §0b.7.8 v1.9.5 entries added documenting the new probe behavior + the save_text tool + the explicit ban on Blob+click in page context.

## [v1.9.4] - 2026-08-03

### Fixed

- **Cherry-pick v1.9.2 (519bb9e) governance infra back onto work/zamelee-bootstrap**: the v1.9.3 fix commit (a27c5fa) was branched directly from v1.9.1 (758c7cf), bypassing v1.9.2 (519bb9e). This meant the CI build-consistency check + release runbook + CHANGELOG header that v1.9.2 added were missing from work/zamelee-bootstrap history, which is exactly the governance gap that allowed "Chrome extensions page still shows 1.8.1 after upgrade" to recur on every release. This commit cherry-picks 519bb9e and bumps `app/chrome-extension/package.json` 1.9.3 → 1.9.4. After `git checkout v1.9.4 && pnpm build`, the Chrome extensions page will show 1.9.4 (and stay in sync going forward via the CI workflow).

### Why a new minor (v1.9.4) instead of amending v1.9.3

- v1.9.3 (a27c5fa) was already pushed + tagged (v1.9.3) + force-pushed to `origin/work/zamelee-bootstrap`. Amending it would break the published tag + any downstream consumer that already pulled v1.9.3.
- The bridge running in production is v1.9.3 protocol (HTTP 200 + SESSION_NOT_FOUND CallToolResult). Cherry-picking v1.9.2 governance infra is a backward-compatible additive: the new files (`.github/workflows/build-consistency.yml`, `docs/wiki/release-runbook.md`) have no runtime impact on bridge / extension behavior. tag v1.9.4 reflects this honestly.

### Changed

- `app/chrome-extension/package.json`: 1.9.3 → 1.9.4 (this release)

### Tests

- 107/107 native-server pass (v1.9.3 fix unchanged)
- 505/505 chrome-extension pass (v1.9.3 fix unchanged)
- New file: `.github/workflows/build-consistency.yml` (75 lines, cherry-picked from 519bb9e) — prevents future 3-layer version drift at PR time
- New file: `docs/wiki/release-runbook.md` (129 lines, cherry-picked from 519bb9e) — canonical 5-step user flow + common pitfalls table

### Notes

- For users currently on v1.9.3: nothing actionable. The bridge protocol is unchanged. v1.9.4 is governance-only: it just ensures your future upgrade won't show a stale version on the Chrome extensions page.
- The .output/chrome-mv3/manifest.json should read "version": "1.9.4" after `pnpm build` from this commit. Verify via `node -e "console.log(require('./app/chrome-extension/.output/chrome-mv3/manifest.json').version)"`.

### Fixed

- **HTTP POST /mcp on stale sessionId: HTTP 400 → HTTP 200 + SESSION_NOT_FOUND CallToolResult** (RFC `docs/rfcs/2026-08-02-mcp-session-soft-degradation.md` §5.3 spec compliance). Previously, server/index.ts POST handler returned HTTP 400 `{error: "Invalid MCP request or session"}` when `request.headers['mcp-session-id']` did not match any active transport. This pre-empted the v1.8.1 soft-degradation protocol: the JSON-RPC `error` envelope never reached the client, so Codex desktop MCP client could not read `_meta.recommendation='re_initialize'` to recover. Fix: stale-sessionId path now returns HTTP 200 + JSON-RPC `result` with `{content: [{type: "text", text: "{code:'SESSION_NOT_FOUND', recommendation:'re_initialize', ...}"}], isError: true, _meta: {sessionStatus: 'stale_recovered', recommendation: 're_initialize'}}`. Clients that respect MCP JSON-RPC envelope semantics can now re_initialize cleanly instead of looping on 400.
- **Pre-existing TS error in session-meta.ts**: `computeLiveTargetsSyncLag(conn, reloadContext, nowMs)` was called with 3 args but function signature is 2-arg (per RFC §5.2 phase 1a review). Removed nowMs arg. Required fixing before `tsc --noEmit` would pass.
- `app/native-server/package.json`: 1.8.2 → 1.9.3 (version sync)
- `app/chrome-extension/package.json`: 1.9.1 → 1.9.3 (version sync)

### Tests

- integration.test.ts: 4/4 pass (Scenario 1+2+3 + Sanity).
- Total: 107/107 native-server + 505/505 chrome-extension pass.

### Notes

- v1.9.3 is a direct fix for the bug visible in user-facing sessions: mcp-chrome HTTP variant would return 400 "Invalid MCP request or session" on every call after extension reload because Codex client keeps the stale sessionId. v1.9.3 makes the response shape RFC-compliant so clients can re_initialize.
- Per AGENTS.md §0b.7.8 v1.8.1 + v1.8.1 RFC §5.3, the SESSION_NOT_FOUND response should be HTTP 200 + CallToolResult with _meta. This commit implements that spec.

## [v1.9.3] - 2026-08-03

### Fixed

- **HTTP POST /mcp on stale sessionId: HTTP 400 → HTTP 200 + SESSION_NOT_FOUND CallToolResult** (RFC `docs/rfcs/2026-08-02-mcp-session-soft-degradation.md` §5.3 spec compliance). Previously, server/index.ts POST handler returned HTTP 400 `{error: "Invalid MCP request or session"}` when `request.headers['mcp-session-id']` did not match any active transport. This pre-empted the v1.8.1 soft-degradation protocol: the JSON-RPC `error` envelope never reached the client, so Codex desktop MCP client could not read `_meta.recommendation='re_initialize'` to recover. Fix: stale-sessionId path now returns HTTP 200 + JSON-RPC `result` with `{content: [{type: "text", text: "{code:'SESSION_NOT_FOUND', recommendation:'re_initialize', ...}"}], isError: true, _meta: {sessionStatus: 'stale_recovered', recommendation: 're_initialize'}}`. Clients that respect MCP JSON-RPC envelope semantics can now re_initialize cleanly instead of looping on 400.
- **Pre-existing TS error in session-meta.ts**: `computeLiveTargetsSyncLag(conn, reloadContext, nowMs)` was called with 3 args but function signature is 2-arg (per RFC §5.2 phase 1a review). Removed nowMs arg. Required fixing before `tsc --noEmit` would pass.
- **app/native-server/package.json**: 1.8.2 → 1.9.3 (version sync)
- **app/chrome-extension/package.json**: 1.9.1 → 1.9.3 (version sync, so Chrome extensions page shows 1.9.3 after rebuild)

### Tests

- integration.test.ts: 4/4 pass (Scenario 1+2+3 + Sanity). Previously Sanity was passing too because the new SESSION_NOT_FOUND test path now exists from this commit.
- Total: 107/107 native-server + 505/505 chrome-extension pass.

### Notes

- v1.9.3 is a direct fix for the bug visible in user-facing sessions: mcp-chrome HTTP variant would return 400 "Invalid MCP request or session" on every call after extension reload because Codex client keeps the stale sessionId. v1.9.3 makes the response shape RFC-compliant so clients can re_initialize.
- Per AGENTS.md §0b.7.8 v1.8.1 + v1.8.1 RFC §5.3, the SESSION_NOT_FOUND response should be HTTP 200 + CallToolResult with _meta. This commit implements that spec.

=======

## [v1.9.2] - 2026-08-03

### Added

- **CI build consistency check** (`.github/workflows/build-consistency.yml`). Runs on PR/push to `master`/`main`/`develop` that touches `app/chrome-extension/package.json` or `wxt.config.ts`. Runs `pnpm install --frozen-lockfile` + `pnpm build`, then asserts `manifest.version === package.json.version`. Fails the PR if mismatch with actionable error message ("bump package.json or amend commit + force push tag"). Prevents the bug where release tag v1.9.1 pointed to source code with `package.json` at 1.9.0 (no bump done in the original commit), leaving the user's Chrome extensions page showing stale 1.8.1 after `git checkout v1.9.1 && pnpm build`.
- **Release runbook** (`docs/wiki/release-runbook.md`). Documents the three-layer version sync (git tag → package.json → manifest.json), the 5-step user flow (`git checkout` → `pnpm install` → `pnpm build` → verify → Chrome reload), common pitfalls table, and CI auto-check pointer.

### Changed

- `app/chrome-extension/package.json`: 1.9.1 → 1.9.2 (this release)

### Notes

- v1.9.2 is the **release tooling patch**: no production code change.

## [v1.9.1] - 2026-08-03

### Added

- **CI build consistency check** (`.github/workflows/build-consistency.yml`). Runs on PR/push to `master`/`main`/`develop` that touches `app/chrome-extension/package.json` or `wxt.config.ts`. Runs `pnpm install --frozen-lockfile` + `pnpm build`, then asserts `manifest.version === package.json.version`. Fails the PR if mismatch with actionable error message ("bump package.json or amend commit + force push tag"). Prevents the bug where release tag v1.9.1 pointed to source code with `package.json` at 1.9.0 (no bump done in the original commit), leaving the user's Chrome extensions page showing stale 1.8.1 after `git checkout v1.9.1 && pnpm build`.
- **Release runbook** (`docs/wiki/release-runbook.md`). Documents the three-layer version sync (git tag → package.json → manifest.json), the 5-step user flow (`git checkout` → `pnpm install` → `pnpm build` → verify → Chrome reload), common pitfalls table, and CI auto-check pointer. The canonical place future maintainers point new contributors to when "the extension still shows 1.8.1 after upgrade" comes up.
- **Permanent CHANGELOG header** (above v1.9.1 entry). Bold "build reminder" callout at top of CHANGELOG pointing to release runbook + CI workflow. Any user scrolling changelog sees the reminder before reading the first entry.

### Changed

- `app/chrome-extension/package.json`: 1.9.1 → 1.9.2 (this release)

### Notes

- v1.9.2 is the **release tooling patch**: no production code change. The only "user-visible" effect is that the Chrome extensions page now shows 1.9.2 (instead of 1.9.1) after `git checkout v1.9.2 && pnpm build && reload`.
- v1.9.1 was missing this bump — it lived in a state where source code matched v1.9.0 + tests (since v1.9.1 was test-only additions to v1.9.0 PR#1). v1.9.2 commits the version bump that should have been in v1.9.1.
- For users currently on v1.9.0 source code: nothing actionable; v1.9.0 → v1.9.2 are tooling-only diffs.

### Added

- **Playwright integration tests (v1.9 RFC PR#2)** - `app/chrome-extension/tests/e2e/watchdog.spec.ts` (3 tests) + `app/chrome-extension/playwright.config.ts`. Tests use `launchPersistentContext` with `channel: 'chrome'` (system Chrome stable) and `--load-extension` to load mcp-chrome unpacked. Verifies:
  - chrome.alarms heartbeat fires at ~30s under real Chrome
  - MV3 SW idle freeze survival (60s no user interaction)
  - reconcileState recreates offscreen after force close
    Run via `pnpm test:e2e` (added as npm script). Skips automatically when `.output/chrome-mv3` not built.
- **Smoke test runbook (v1.9 RFC PR#3)** - `docs/wiki/v1.9.0-smoke-test-runbook.md` (3.5KB). 30-minute guide for users to collect `[telemetry]` console output in real Chrome and send to maintainer. Includes maintainer checklist (heartbeat count > 30, max gap < 90s, source distribution includes `alarm`, ownerId drift).

### Notes

- v1.9.1 is the test-infra + docs followup to v1.9.0 (PR#1 keepalive reconcile + telemetry). No production code changes.
- 505/505 vitest unit tests still pass; Playwright e2e tests are separate (run via `pnpm test:e2e`).

## [v1.9.0] - 2026-08-03

### Added

- **keepalive-manager.ts reconcileState() (NORMAL/DEGRADED/RECOVERING state machine)** - v1.9 PR#1 covers the offscreen-document self-heal scenario per ChatGPT R2 §Testing-strategy (RFC `docs/rfcs/2026-08-03-v19-keepalive-reconcile-playwright-smoke.md`). Each `chrome.alarms` heartbeat trigger now also calls `reconcileState()` before `doHeartbeat()`. If `chrome.offscreen.hasDocument()` returns false (Chrome memory pressure reaped the offscreen doc), reconcileState returns `{kind: 'recovering', action: 'createOffscreen'}` and logs to console. Native-host reconnect is deferred to v1.10 (out of v1.9 PR#1 scope; would require native-bridge protocol change).
- **telemetry.ts heartbeat event collector** - Records `{type, source, scheduledAt, firedAt, delayMs, ownerId, isStale}` per heartbeat. Source = `setInterval` | `alarm` | `chrome.tabs` | `manual`. Outputs single-line JSON via `console.log('[telemetry] ...')` for grep / parsing. 200-entry rolling buffer (test-only `_resetTelemetryBufferForTests()`). Per AGENTS.md §0b.7.7 zero-disk default: telemetry is console-only, no local persistence. Future v1.10 may auto-upload to GitHub Issues.
- **`bridge-control.ts` source attribution** - `doHeartbeat()` now takes a `HeartbeatSource` arg; setInterval path uses `setInterval`, chrome.alarms path uses `alarm`, chrome.tabs.* listener uses `chrome.tabs`. Each call writes one telemetry entry.
- **`vitest.setup.ts` chrome.offscreen mock** - `hasDocument` / `createDocument` / `closeDocument` / `Reason` enum. Default `hasDocument()` returns `true`; tests override per case.

### Tests

- New: `app/chrome-extension/tests/background/keepalive-manager.test.ts` (5 tests). Covers normal state, recovering state on missing offscreen, bounded history (50 entries), last-health snapshot, hasDocument-throws-treated-as-missing path.
- `tests/background/bridge-control.test.ts` (3 tests, unchanged) — still passes, now also emits telemetry lines.

### Notes

- This is v1.9 **PR#1 only**: keepalive-manager + telemetry. v1.9 PR#2 (Playwright integration test) and PR#3 (smoke runbook) are separate.
- 505/505 chrome-extension tests pass; native-server tests unchanged from v1.8.3 (107/107).
- No production wire-up changes — only adds defensive self-heal in background SW.

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
