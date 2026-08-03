# Handoff: Chrome Debugger Busy vs MCP SESSION_EXPIRED

**Recorded**: 2026-08-03
**Context**: Codex 端通过 mcp-chrome 操作 Chrome tab 时,反复混淆这两个看似相似但根因完全不同的"工具失灵"现象。本次会话在 `catgirl Chrome MCP Server` 1.7.0 / 1.8.0 期间多次撞这两个坑,handoff 给未来会话(以及维护者本人)留一份辨别手册。

---

## TL;DR — 30 秒判断

| 现象                                                                                                    | 根因                                                                        | 关键词                                                                   | 修法                                                              |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `HTTP 400 Invalid MCP request or session` / `SESSION_EXPIRED`                                           | **bridge session 层面** — Codex MCP client 持有 stale sessionId             | "Invalid MCP request", "SESSION_EXPIRED", "session expired"              | reload extension / 切 stdio variant(§0b.7.8 #3)                   |
| `Debugger is busy (DevTools or another extension attached)` + `engine: "scripting"` + `returned: false` | **CDP client 层面** — Chrome tab debugger slot 被 F12 或别的 extension 占用 | "Debugger is busy", "Falling back to chrome.scripting", engine=scripting | 关 F12 / 用第二个 Chrome profile / 改用不依赖 debugger 的工具组合 |

**绝对不要混在一起修**。SESSION_EXPIRED 修了 != Debugger busy 也修了 —— 这俩在不同抽象层。

---

## 1. SESSION_EXPIRED — bridge session 层面

**机制**: Codex MCP client (HTTP transport) 通过 `mcp-session-id` header 标识一个会话。extension reload 后,bg service worker 重新注册,bridge 进程内部 sessionId 表被清空。但 Codex 端 transport 还持有旧 sessionId -> 下一次 write 类调用返 `HTTP 400 Invalid MCP request or session`。

**触发源**(按频率):

1. `chrome://extensions` 点 Refresh(每次开发 reload)
2. `pnpm build` 触发 wxt HMR -> extension 自动 reload
3. Chrome 自身重启
4. 生产环境 Chrome Web Store update(本项目 Load unpacked 不触发)

**Codex 端 behavior**(v1.8.1 之前的 deprecated path,代码见 `app/native-server/src/server/index.ts:354`):

```json
{
  "code": "SESSION_EXPIRED",
  "recoverable": true,
  "toolName": "<tool_name>",
  "message": "Session expired for tool ... last heartbeat <N>s ago. The Chrome extension was reloaded; re-initialize MCP session."
}
```

**v1.8.1+ RFC 5.3 + v1.9.3 commit(已经修完)**:

- 改返 HTTP 200 + JSON-RPC `result` + `code: SESSION_NOT_FOUND` + `_meta.recommendation: re_initialize`
- Codex client 收到 `_meta` 后理论上应 re_initialize(取决于 Codex 实现)
- 即使 Codex client 不读 `_meta`,也至少拿到 JSON-RPC envelope 而不是 raw HTTP 400

**AGENTS.md 引用**: `~/.codex/AGENTS.md` 0b.7.8(全部小节)

**临时 fallback**(HTTP variant 持续 SESSION_EXPIRED 时):

1. `~/.codex/config.toml` -> `[mcp_servers.mcp-chrome]` `enabled = false`
2. `[mcp_servers.mcp-chrome-stdio]`(默认 enabled)保留
3. **重启 Codex desktop**(Codex 不支持热切 MCP server config)
4. 下次 mcp-chrome 调用走 stdio path,无 session 概念,自动 init

---

## 2. Debugger is busy — CDP client 层面

**机制**: Chrome 对每个 tab 维护**唯一一个 debugger slot**。F12 DevTools 打开 = slot 被 F12 占。mcp-chrome 的 `chrome.debugger.attach({tabId, ...})` 直接被 Chrome 拒绝,抛 `Another debugger is already attached`。

**绝对硬约束**,跟 mcp-chrome 实现质量无关。任何走 `chrome.debugger` API 的 extension(Vue DevTools / React DevTools / chrome-devtools-mcp / mcp-chrome)都受这个限制。

**mcp-chrome 已经做了 graceful fallback**(代码见 `app/chrome-extension/entrypoints/background/tools/browser/javascript.ts:1-180`):

```typescript
type ExecutionEngine = 'cdp' | 'scripting';
type ErrorKind = 'debugger_conflict' | 'timeout' | 'no_result' | ...;

function isDebuggerConflictError(error: unknown): boolean {
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target/i
    .test(message);
}
```

- Primary path: `chrome.debugger.attach` + CDP `Runtime.evaluate`(page context, await + returnByValue)
- Fallback path: `chrome.scripting.executeScript`(ISOLATED world,能力受限)
- Detection: 正则匹配 conflict 错误 -> 切降级
- Response 诚实标注: `warnings: ["Debugger is busy ... Falling back to chrome.scripting.executeScript (runs in ISOLATED world, not page context)."]` + `engine: "scripting"`

### 降级后能做什么 / 不能做什么

| 操作                                                        | debugger 路径                    | scripting fallback                                                                              | F12 开着时                  |
| ----------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| `chrome_click_element`                                      | `executeScript` + event dispatch | OK 同(本来就不依赖 debugger)                                                                    | OK                          |
| `chrome_extract` (读 DOM attribute/innerText)               | `executeScript` + DOM query      | OK 同                                                                                           | OK                          |
| `chrome_javascript` (page JS 探针)                          | CDP `Runtime.evaluate`           | 警告 降级后 ISOLATED world 拿不到 page-context 变量(ProseMirror state / React Fiber / 跨 frame) | 警告 返回 `returned: false` |
| `chrome_console` / `chrome_network_capture` (debugger 模式) | CDP attach                       | NO 直接 conflict                                                                                | NO                          |
| `chrome_read_page` (snapshot)                               | 注入 helper 脚本                 | 警告 snapshot 主体是 read-only,降级路径可拿 innerText 拿不到 React state                        | 警告                        |

### 用户视角的解法

1. **用 mcp-chrome 时关 F12**(99% 场景最优解,二选一)
2. **开第二个 Chrome 实例**(incognito / 第二个 profile)— 一个手动 DevTools,一个 mcp-chrome
3. **改用不依赖 debugger 的工具组合**:
   - `chrome_click_element` + `chrome_extract` 替代 page JS 探针
   - 对 chatgpt ProseMirror 注入: `click` 触发事件, `extract` 读 innerText 验空(够用,不用读 ProseMirror transaction count)
4. **真要读 page state**: 关 F12 后用 `chrome_javascript`(完整 CDP path)

---

## 3. 为什么容易混淆

- 都是 "mcp-chrome 突然不工作" 的现象
- 都有 "reload/restart 也许就好了" 的临时表象
- Codex 端 error 抛出形式相似(都是 `error` 字段有 message)
- AGENTS.md 0b.7.8 详细描述 SESSION_EXPIRED,但 0b.4 #1 "Allow remote debugging? 弹窗" 是 Debugger busy 的精神先例,容易漏看

**辨别 checklist**(出问题时按顺序 5 秒判断):

1. **error.message 含 "Invalid MCP request" / "session expired"** -> SESSION_EXPIRED -> 0b.7.8
2. **error.message 含 "Debugger is busy" / "Another debugger is already attached"** -> Debugger busy -> 0b.4 #1 精神
3. **warnings 里有 "Falling back to chrome.scripting.executeScript"** -> Debugger busy(已经 fallback,但能力受限)
4. **response 里 `engine: "scripting"`** -> Debugger busy 触发的降级产物
5. **两者同时出现**: 可能先 Debugger busy(agent 反复 retry 触发 0b.5 F-DebugSpree 阈值),再 SESSION_EXPIRED(用户 reload extension 试图修前一个)。这种情况**先把 F12 关掉**,再 reload extension。

---

## 4. 反例 / 教训

- NO **反例 1**: 看到 "mcp-chrome 不工作" 就 reload extension。SESSION_EXPIRED 可能好,Debugger busy 不会好,反而引入新的 SESSION_EXPIRED(reload 本身触发 sessionId 失效)
- NO **反例 2**: 看到 "Falling back to chrome.scripting" 以为是 mcp-chrome 降级成功,继续发 page-context 探针,等返回 `returned: false` 才反应过来
- NO **反例 3**: 关掉 F12 但忘了关 chrome-devtools-mcp 也在 attach(如果启用了的话),冲突仍持续
- NO **反例 4**: 用户反复切 Chrome profile 试图解决 SESSION_EXPIRED,根因是 Codex client 缓存 stale sessionId,跟 profile 无关
- NO **反例 5**: agent 撞 Debugger busy 后,反复 retry 同一个 `chrome_javascript` 调用(同种失败 >=3 次触发 0b.5 F-DebugSpree 阈值,写 incident.kind=debug-spree 走 10.1 自动置 null)
- OK **正解**: 看到 Debugger busy warning 立即停 js 探针,改用 `click + extract` 组合;告诉用户 "你在 tab 上开了 F12,要么关要么换 Chrome 实例"

---

## 5. 防复发 checklist(给未来会话 / agent)

写给 Codex Agent 自己:

```
- chrome_javascript 调用前,先看上次 response 的 warnings
  - 含有 "Debugger is busy" -> 立刻停,改 click_and_wait / chrome_extract
  - 没有 -> 正常发
- chrome_console / chrome_network_capture 报 debugger busy -> 同上,不重试
- Codex 端收到 HTTP 400 + "Invalid MCP request or session" -> 0b.7.8 path
  - 重启 Codex / 切 stdio variant
  - 不要试图改 user-data-dir / kill Chrome 进程 / 手搓 WebSocket
- 累计同种失败 >= 3 次 -> 写 incident.kind=debug-spree 走 10.1
  - 严禁 "再多试一次"
```

写给用户:

```
- 用 mcp-chrome 操作 tab 时,那个 tab 不要开 F12
  - 需要 DevTools 时开第二个 Chrome instance / incognito
- reload extension 后第一个 write 类工具调用会 SESSION_EXPIRED (v1.9.3 缓解)
- 看到 extensions page 上版本号不对,按 docs/wiki/release-runbook.md 5 步流程
```

---

## 6. 如果将来想 "做得更好",可选 polish(非阻塞)

按 v1.10 RFC 候选评估,**不**在 v1.9.x 范围内:

| 方向                                                                  | 收益                                    | 成本                                                   | 推荐度    |
| --------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------ | --------- |
| 拆 `chrome_javascript` 成 cdp / isolated 两个独立工具                 | agent 主动选 ISOLATED,不用撞墙 fallback | schema 复杂化,工具数量 +1                              | 中        |
| fallback warning 更明确: "你需要关闭 DevTools 才能用 CDP-based tools" | 用户立刻知道怎么处理                    | doc polish, 0 风险                                     | 高        |
| 加 `chrome_detach_debugger` 工具                                      | (理论) agent 主动让出 slot              | detach 后 mcp-chrome 自己 attach 不了,跟"开 F12"无差别 | NO 不实用 |
| wait-and-retry 自动恢复                                               | F12 关掉后自动切回 CDP                  | 触发 0b.5 F-DebugSpree 阈值,浪费 token                 | NO 不推荐 |

---

## 7. 引用一览

- AGENTS.md 0b.7.8 v1.8.1 RFC + 行为契约
- AGENTS.md 0b.4 #1 "Allow remote debugging?" 故障处理
- AGENTS.md 0b.5 通用契约 + F-DebugSpree
- AGENTS.md 10.1 工具环境层 M1 自动置 null
- `app/native-server/src/server/index.ts:354` — SESSION_NOT_FOUND 修法(v1.9.3)
- `app/chrome-extension/entrypoints/background/tools/browser/javascript.ts:1-180` — debugger conflict detection + scripting fallback
- `docs/wiki/release-runbook.md` — 三层版本号关系图 + 5 步 release 流程
- `docs/rfcs/2026-08-02-mcp-session-soft-degradation.md` — v1.8.1 RFC 全文

---

## 8. 一句话总结

**SESSION_EXPIRED 是 bridge session 身份问题(Codex <-> bridge),Debugger busy 是 Chrome tab 资源问题(F12 <-> extension)。前者 reload extension 或切 stdio,后者关 F12 或换 Chrome 实例。看到 "mcp-chrome 不工作" 时先读 error.message 关键词,再选修法,不要混着治。**
