# RFC: MCP Watchdog / Keepalive Hardening (v1.8.2)

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Status         | Draft                                  |
| Author         | Codex                                  |
| Created        | 2026-08-02                             |
| Target version | v1.8.2                                 |
| Discussion     | handoff thread 2026-08-02              |

## 1. 摘要

补强 v1.8.1 soft-deg 协议在 MV3 service worker idle freeze 场景下的盲区。具体改动：

1. 加 `chrome.alarms` 30s 触发 heartbeat — 即使 SW 被 Chrome 冻死也保证 producer 活着
2. `HEARTBEAT_STALE_MS`: 90s → **150s**（R2 ChatGPT 数学审阅后的完整 jitter 预算）
3. `HEARTBEAT_INTERVAL_MS`: 60s → **30s**（与 alarm 周期同步）

不推翻 v1.8.1 soft-deg；两者是 orthogonal layer。

## 2. 背景 / Motivation

### 2.1 v1.8.1 解决了什么，没解决什么

v1.8.1 软降级协议针对的是 **identity continuity**：
- extension reload 触发 ownerId 变化
- bridge 检测到 → 返回 `_meta.sessionStatus="stale_recovered"` 或 retryable `EXTENSION_STARTING`
- Codex client 不需要升级

**v1.8.1 不解决的是 runtime liveness**：
- MV3 SW 30s idle 后被 Chrome freeze
- `setInterval` 跟着死
- heartbeat 永远不到 bridge
- bridge 看到 heartbeatGap > 90s → `STALE_RECOVERED`
- 但实际上是 SW 被冻，不是真 reload
- 软降级也救不了 — 因为**根本不是 reload**

### 2.2 用户反馈

> "时间长了就扩展就假死了"

实际触发的就是 MV3 SW freeze 链路：
1. 用户开 page → 30s 内不做任何事 → SW freeze
2. setInterval 跟着死，heartbeat 永远不到
3. bridge 端 `lastHeartbeat` 老化过 90s
4. 下次用户做 mcp-chrome 操作 → preflight 失败 → SESSION_EXPIRED
5. 实质问题：不是 SW 死了，是 SW 被冻了

## 3. 目标 / Goals

1. SW 被 Chrome freeze 后，仍然能定期触发 heartbeat
2. heartbeat 频率从 60s 加密到 30s（更细粒度，更快恢复）
3. stale threshold 从 90s 放宽到 150s（吸收 alarm jitter）
4. 不破坏 v1.8.1 soft-deg 协议
5. Chrome < 120 降级行为合理（alarm min 1 min，那部分用户 stale threshold 不严格保证）

## 4. 设计

### 4.1 chrome.alarms 30s wakeup

```ts
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_ALARM_NAME = 'bridge-heartbeat';

function startHeartbeat() {
  stopHeartbeat();
  state.timer = setInterval(() => void doHeartbeat(), HEARTBEAT_INTERVAL_MS);
  // v1.8.2: alarm 30s wakes SW even after MV3 idle freeze; setInterval 30s
  // is the backup for when SW is alive. Both fire idempotent doHeartbeat().
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM_NAME) return;
  triggerImmediateHeartbeatIfActive();  // existing guard: state.timer !== null
});
```

**关键事实**:
- `chrome.alarms` 调度独立于 SW 生命周期 — SW 死了 alarm 仍能叫醒
- Chrome < 120: 1 minute 最小周期（不覆盖用户，降级到 setInterval 60s）
- Chrome >= 120: 30 seconds 最小周期（我们用的）
- alarm 不是精确计时器，是 "not earlier than"，实际可能 40-70s

### 4.2 stale threshold 150s 数学

ChatGPT R2 完整 jitter 预算：

| 因素 | 数值 | 说明 |
|---|---|---|
| alarm jitter (worst) | 70s | "not earlier than" 边界 |
| SW cold start | 5s | complex extension 重新加载 JS + IndexedDB migration |
| network RTT | 5s | localhost < 10ms；remote/VPN up to 5s |
| bridge processing | 1s | doHeartbeat → register → write heartbeat state |
| **margin** | 69s | 兜底 |
| **total** | **150s** | |

150s = 5 × HEARTBEAT_INTERVAL_MS(30s)，允许**连续两个 worst-case alarm delay** 才判断扩展死亡。

### 4.3 与 v1.8.1 soft-deg 的关系

| layer | v1.8.1 解决 | v1.8.2 解决 |
|---|---|---|
| identity continuity (ownerId drift) | ✓ | (保留) |
| runtime liveness (SW frozen) | ✗ | **✓** |
| machine sleep (laptop wake hours later) | ✗ | ✗ (product-UX) |

**两者 orthogonal，不合并成一个状态机**。stale_threshold 是共同输入，但 action 不同：
- v1.8.1: stale + ownerId 变化 → EXTENSION_STARTING (retryable error)
- v1.8.2: 不再 stale (更多 heartbeat 到达)，但真 stale 时仍走 v1.8.1 路径

## 5. Testing-strategy

按 ChatGPT R2 推荐的三层策略：

### Layer 1: Unit (vitest)
- mock `chrome.alarms`
- 验证 `create({ periodInMinutes: 0.5 })` arg shape
- 验证 `clear(HEARTBEAT_ALARM_NAME)` on stop
- 验证 port-dedup no-op
- **覆盖 70%**：测试通过 ✓ (3 tests in `tests/background/bridge-control.test.ts`)

### Layer 2: Integration (Playwright)
- `chromium --load-extension=dist`
- mock bridge server localhost
- 暴露 debug command 触发 alarm handler
- **状态**: 未实现（v1.9 RFC）

### Layer 3: Real Chrome smoke
- Chrome 134+ Windows 30 分钟实测
- 60 samples, mean / p95 / max delay
- **状态**: 未实现（v1.9 RFC）

**telemetry** (v1.9 RFC):
```ts
{ type: "heartbeat", source: "alarm", scheduledAt, firedAt, delay }
```
用户反馈"假死"时直接查 alarm / bridge / SW restart 哪个环节慢。

## 6. Open issues

1. **machine sleep** 不靠 threshold 解决。需要：
   - 用户 active 后 SW 重启 → 立即 heartbeat
   - 或产品层 detect "扩展曾离线 N 小时" → 告知用户
2. **Playwright integration test** 在此 patch 范围外（v1.9）
3. **Real Chrome 30min smoke test** 在此 patch 范围外（v1.9）

## 7. Rollout

1. v1.8.2 PR：chrome.alarms + threshold bump + 3 unit tests
2. 加载到扩展，跑了 1 周看是否有 regression
3. v1.9 RFC：keepalive-manager reconcileState + Playwright integration + smoke test