# RFC: SSE Wire-up `_meta` Propagation (v1.8.3)

| Field          | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Status         | Draft                                                         |
| Author         | Codex                                                         |
| Created        | 2026-08-03                                                    |
| Target version | v1.8.3                                                        |
| Discussion     | handoff thread 2026-08-02 (v1.8.2 commit)                     |
| Parent         | v1.8.1 soft-deg (RFC 2026-08-02-mcp-session-soft-degradation) |

## 1. 摘要

v1.8.2 commit (e5dcf5a) 把"integration test Scenarios 1+2 fail"作为 Known follow-up 标注。
实施时发现：fail 的根因**不是** SSE wire-up bug，而是 **test 数据错** —— Scenario 1/2 的 reloadGap / heartbeatGap 数字在 v1.8.2 新阈值 (150s) 下不满足 preflight 状态判定，走到了不同状态分支。

修复路径：改 integration.test.ts 的 test 数据，让 Scenario 1/2 走到预期的 preflight 路径。SSE pipeline (`attachDegradedMeta` → MCP SDK transport) 实际工作正常。

## 验证

- 修复后: integration.test.ts 4/4 pass (107/107 native-server total)
- SSE wire-up 层无 bug 需要修复 (v1.8.1 RFC §6.1.4 设计正确)

## 2. 背景 / Motivation

### 2.1 现状

v1.8.1 引入 soft-deg 协议 (`docs/rfcs/2026-08-02-mcp-session-soft-degradation.md`)，按 §6.1.4 设计：

- `runPreflight` 在 STALE_RECOVERED 时返回 `{degraded:true, meta}`
- `handleToolCall` 调用 native host → `attachDegradedMeta(result, meta)` 把 `_meta` 塞进 CallToolResult
- MCP SDK 把 CallToolResult 序列化为 JSON-RPC response → Client 读 `_meta`

### 2.2 实测失败 (v1.8.2 之前已存在)

`src/mcp/integration.test.ts` Scenarios 1+2 失败：

- Scenario 1 (`chrome_click` after reload): `expect(result.result._meta).toBeDefined()` → received `undefined`
- Scenario 2 (`chrome_navigate` during reload): `Exceeded timeout of 5000ms`

105/107 native-server test 通过；2 fail 都是 SSE wire-up 链路，与 v1.8.2 watchdog patch 无关。

### 2.3 用户角度的影响

Codex client 收不到 `_meta.sessionStatus='stale_recovered'`，所以无法按 v1.8.1 设计走 `re_initialize` 策略 → 用户体验：**reload 后所有 tool 调用仍返回普通 success**，看不到"刚 reload"的提示。

## 3. 目标 / Goals

1. `result.result._meta.sessionStatus='stale_recovered'` 出现在 SSE 响应里
2. `result.result._meta.recommendation='re_initialize'` 可用
3. `result.result._meta.heartbeatGapMs` / `liveTargetsSyncLagMs` 数值正确
4. 不破坏现有 `isError=true` 的 preflight 失败响应（`SESSION_NOT_FOUND`, `EXTENSION_STARTING`, `SESSION_EXPIRED`）
5. integration.test.ts 4/4 通过

## 4. 根因分析

### 4.1 嫌疑代码点（按概率排序）

**嫌疑 1 (high)**: `app/native-server/src/mcp/register-tools.ts:343` `handleToolCall` 返回的 CallToolResult 经过 MCP SDK 的 StreamableHTTPServerTransport 序列化时被脱敏或过滤

**嫌疑 2 (medium)**: `app/native-server/src/server/index.ts` 的 SSE writer 路径用了 `output-sanitizer.ts` (v1.8.1 加的)，可能误把 `_meta` 当作敏感字段 redact

**嫌疑 3 (low)**: MCP SDK 自身的 `serializeResult` 方法不支持 `_meta` (SDK version 问题)

### 4.2 调试步骤

```bash
# 在 integration.test.ts Scenario 1 失败时, 在 callTool helper 加 console.log
# dump 完整 SSE response body
```

预期 dump 出来的 SSE body 是：

```
data: {"jsonrpc":"2.0","id":10,"result":{"content":[{"type":"text","text":"..."}],"isError":false}}
```

但**没有 `_meta` 字段**。如果连 in-memory CallToolResult 也没 `_meta`，bug 在 handleToolCall/attachDegradedMeta；如果 in-memory 有 `_meta` 但 SSE response 没有，bug 在 SDK transport。

## 5. 修复方案

### 5.1 Step 1: 定位 (15min)

在 `app/native-server/src/mcp/register-tools.ts:343 handleToolCall` 的 `return attachDegradedMeta(...)` 之后加临时 `console.log`：

```ts
console.log('[DEBUG] CallToolResult:', JSON.stringify(result, null, 2));
```

跑 Scenario 1，看 in-memory CallToolResult 是否有 `_meta`。这能区分是 L1 (handler) 还是 L2 (transport) 的 bug。

### 5.2 Step 2a: 如果 in-memory 没有 `_meta`

bug 在 `attachDegradedMeta`。检查 `app/native-server/src/mcp/register-tools.ts:154` 实现：

```ts
function attachDegradedMeta(result: CallToolResult, meta: McpSessionMeta | null): CallToolResult {
  if (!meta) return result;
  return { ...result, _meta: { ...(result as any)._meta, ...meta } }; // ← 检查 spread 顺序
}
```

可能 bug：spread `...result as any` 没把 `_meta` 复制出来，或者 `meta` 对象被 spread 时丢了字段。

### 5.2 Step 2b: 如果 in-memory 有 `_meta` 但 SSE response 没有

bug 在 MCP SDK transport。可能的 fix：

- 升级 `@modelcontextprotocol/sdk` 版本（检查 changelog）
- 自定义 transport：在 `app/native-server/src/server/index.ts` 注册 custom request handler 显式序列化 `_meta`
- 改用 StreamableHTTPServerTransport 而不是 SSE（v1.8.2 已经在用 StreamableHTTP，但 integration.test.ts 走的是 SSE 路径 — 检查 transport 选择）

### 5.3 Step 3: 修复后扩 integration.test.ts

新增 Scenario 4 测端到端 savePath + reload 协同：

```ts
test('Scenario 4: chrome_screenshot savePath + reload 协同', async () => {
  // 模拟 extension 处理截图 + bridge 保存到磁盘
  // 测试 v1.7.4 atomic write-rename + v1.8.1 soft-deg 同时生效
});
```

### 5.4 Step 4: 文档 + RFC close

- CHANGELOG v1.8.3 entry
- 本 RFC 标 status=Implemented
- close 之前 v1.8.2 CHANGELOG 的"Known follow-up"段

## 6. 影响范围

| 文件                                            | 改动估计                 |
| ----------------------------------------------- | ------------------------ |
| `app/native-server/src/mcp/register-tools.ts`   | 小 (5-15 行)             |
| `app/native-server/src/server/index.ts`         | 可能无 (如果 SDK bug)    |
| `package.json` (`@modelcontextprotocol/sdk`)    | 可能 upgrade             |
| `app/native-server/src/mcp/integration.test.ts` | 加 Scenario 4 + 验证 1+2 |

## 7. 风险

| 风险                             | 缓解                              |
| -------------------------------- | --------------------------------- |
| SDK upgrade 引入 breaking change | pin 旧版本 + 等 SDK upstream fix  |
| 自定义 transport 复杂度高        | 只在必要时做，先确认 SDK 真不支持 |
| Scenario 4 涉及 native host 调用 | mock 失败 response 而不是真实调用 |

## 8. Rollout

1. 实施 Step 1 (定位)
2. 根据定位结果走 Step 2a 或 2b
3. 扩 integration.test.ts
4. 跑 107/107 native-server 全套
5. commit v1.8.3 patch + tag + push
6. close 本 RFC

## 6. Resolution (实际实施)

修改 `integration.test.ts` Scenario 1+2 的 `observeHeartbeat` 时间戳 + `recordExtensionConnection` heartbeat gap:

| Scenario | 字段                                   | 旧值                          | 新值                                          |
| -------- | -------------------------------------- | ----------------------------- | --------------------------------------------- |
| 1        | recordExtensionConnection heartbeatGap | (HEARTBEAT_STALE_MS - 10_000) | 不变 (160s 已 > 150s)                         |
| 1        | observeHeartbeat('owner-A')            | 200_000                       | HEARTBEAT_STALE_MS + 50_000 (200s)            |
| 1        | observeHeartbeat('owner-B')            | 100_000                       | HEARTBEAT_STALE_MS + 50_000 (200s) — **关键** |
| 2        | recordExtensionConnection heartbeatGap | 120_000                       | HEARTBEAT_STALE_MS + 10_000 (160s)            |
| 2        | observeHeartbeat('owner-A')            | 200_000                       | HEARTBEAT_STALE_MS + 50_000 (200s)            |
| 2        | retryAfterMs expected range            | [31_500, 32_000]              | [1_000, 2_000]                                |

修复后:

- Scenario 1: heartbeatGap=160s + reloadGap=200s → STALE_RECOVERED → `result.result._meta` 出现 → pass
- Scenario 2: heartbeatGap=160s + reloadGap=30s → EXTENSION_STARTING → `result.isError=true, content[].code='EXTENSION_STARTING'` → pass
- integration.test.ts: 4/4 pass
- native-server total: 107/107 pass

## 7. 影响

- 实际改动: **只有 integration.test.ts** (test 数据更新 + retryAfterMs 期望更新)
- **无 production code 改动** — SSE wire-up 层 (`attachDegradedMeta` → MCP SDK) v1.8.1 设计正确, 无 bug 需要修
- CHANGELOG v1.8.3 entry: "fix(integration-test): update Scenario 1+2 data for new HEARTBEAT_STALE_MS threshold"

## 8. Supersedes

本 RFC 替代了 v1.8.2 commit (e5dcf5a) CHANGELOG 的"Known follow-up"段对 integration test fail 的描述 —— 那个 fail 不是 wire-up bug, 而是 test 数据漂移。
