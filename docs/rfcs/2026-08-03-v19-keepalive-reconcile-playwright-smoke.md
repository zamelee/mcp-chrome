# RFC: keepalive-manager reconcile + Playwright integration + 30min smoke (v1.9)

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| Status         | Draft                                  |
| Author         | Codex                                  |
| Created        | 2026-08-03                             |
| Target version | v1.9                                   |
| Discussion     | handoff thread 2026-08-02 (v1.8.2 commit e5dcf5a) |
| Parent         | v1.8.2 watchdog (RFC 2026-08-02-mcp-watchdog-keepalive) |

## 1. 摘要

v1.8.2 patch 解决了 Layer 1 (Producer) 的 MV3 SW freeze 问题。本 RFC 覆盖 v1.8.2 末尾 §Open issues 列出的 3 个 follow-up：

1. **keepalive-manager reconcileState()** — 自愈 offscreen document 在 Chrome memory pressure 下被回收的场景
2. **Playwright integration test** — 真实 Chrome + load-extension，跑 watchdog 端到端
3. **30min smoke test** — 真实用户 Chrome 收集 telemetry

## 2. 背景 / Motivation

v1.8.2 (`chrome.alarms` 30s + `HEARTBEAT_STALE_MS` 150s) 解决了：

| gap | 修复 |
|---|---|
| MV3 SW 30s idle freeze 后 setInterval 死 | alarm 30s 触发 wake |
| heartbeat gap 过大 | stale 150s (5x jitter tolerance) |

但**仍有未覆盖的 gap**：

| gap | v1.9 修复 |
|---|---|
| Chrome memory pressure 回收 offscreen document | reconcileState() 检测 hasDocument() + recreate |
| 没真实 Chrome 测试 (只 mock) | Playwright + load-extension |
| 30min 实测数据缺失 | 真实用户 Chrome telemetry |

## 3. 目标 / Goals

1. **keepalive-manager.ts 加 reconcileState()** — 自愈机制覆盖 offscreen 被回收场景
2. **Playwright integration test** — 跑通 watchdog 端到端（mock 之前只能 mock）
3. **30min smoke test 框架** — 真实 Chrome + telemetry 收集
4. **不引入新依赖** — 复用现有 infra (vitest, supertest, MCP SDK)
5. **chrome.alarms.onDestroyed() 缺失场景的 workaround** — ChatGPT R2 提到这个 API 不存在

## 4. 设计

### 4.1 keepalive-manager.ts 加 reconcileState()

当前 `app/chrome-extension/entrypoints/background/keepalive-manager.ts` 用 reference counting：

```ts
interface KeepaliveController {
  acquire(tag: string): () => void;   // returns release fn
  isActive(): boolean;
  getRefCount(): number;
  releaseAll(): void;
}
```

新增 state machine：

```ts
type KeepaliveState =
  | { kind: 'normal'; offscreen: { exists: boolean; lastSeen: number }; sw: { lastHeartbeat: number }; native: { connected: boolean } }
  | { kind: 'degraded'; missing: 'offscreen' | 'native-host' | 'sw'; since: number }
  | { kind: 'recovering'; action: 'createOffscreen' | 'reconnectNative' | 'restartSW'; since: number };

async function reconcileState(): Promise<KeepaliveState> {
  const offscreenExists = await chrome.offscreen.hasDocument();
  if (!offscreenExists) {
    await createOffscreen();
    return { kind: 'recovering', action: 'createOffscreen', since: Date.now() };
  }
  // ... 类似 check native host, SW heartbeat
  return { kind: 'normal', ... };
}
```

**调用点**：
- `onAlarm` 触发时（与 heartbeat 一起跑）
- `chrome.tabs.onCreated` 触发时（tab lifecycle event 已经存在）
- `chrome.runtime.onStartup` 时（SW 启动）

### 4.2 Playwright integration test

测试环境要求：
- 真实 Chrome stable (Playwright `channel: 'chrome'`)
- `--load-extension=<本地 .output/chrome-mv3 路径>`
- 临时 `userDataDir` 隔离 profile
- `headless: false` (headless Chrome 不支持 extension API)

**关键 spec**：

```ts
// tests/v19/playwright-watchdog.test.ts (草案)
import { test, chromium, expect } from '@playwright/test';

test.describe('chrome.alarms heartbeat watchdog (v1.9)', () => {
  test('fires heartbeat at ~30s interval under real Chrome', async () => {
    const userDataDir = `/tmp/mcp-chrome-test-${Date.now()}`;
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome',
      args: [
        '--load-extension=./app/chrome-extension/.output/chrome-mv3',
        '--disable-extensions-except=./app/chrome-extension/.output/chrome-mv3',
      ],
      headless: false,
    });

    const page = await context.newPage();

    // collect heartbeat console.log
    const heartbeats: number[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('[bridge-control] heartbeat')) {
        heartbeats.push(Date.now());
      }
    });

    // wait 35s — expect at least 1 alarm-triggered heartbeat (in addition to setInterval)
    await page.waitForTimeout(35_000);

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    // verify heartbeatGap < 60s (proves alarm works in addition to setInterval)
    for (let i = 1; i < heartbeats.length; i++) {
      const gap = heartbeats[i] - heartbeats[i - 1];
      expect(gap).toBeLessThan(60_000);
    }

    await context.close();
  });

  test('survives MV3 SW idle freeze (60s without user interaction)', async () => {
    // open page, wait 60s with no activity, verify heartbeat still firing
    // (this is the test that v1.8.1 setInterval-only setup would FAIL)
  });

  test('reconcileState recreates offscreen after Chrome memory pressure', async () => {
    // force offscreen close via chrome.offscreen.closeDocument()
    // wait 30s
    // verify next heartbeat triggers reconcileState and recreates offscreen
  });
});
```

**CI 集成**：
- GitHub Actions matrix: Chrome stable on linux/windows
- 不测登录态（用全新 userDataDir）
- 跑 3 tests 总耗时 ~2 分钟

### 4.3 30min smoke test 框架

**不是 Playwright 跑** — 是真实用户 Chrome 后台跑 30 分钟收集 telemetry。

**实现**：

```ts
// app/chrome-extension/entrypoints/background/telemetry.ts (新文件)
import { getV3Runtime } from './record-replay-v3/bootstrap';

interface HeartbeatTelemetry {
  type: 'heartbeat';
  source: 'setInterval' | 'alarm' | 'chrome.tabs' | 'user_action';
  scheduledAt: number;
  firedAt: number;
  delay: number;
  ownerId: string;
}

const TELEMETRY_BUFFER: HeartbeatTelemetry[] = [];

export function recordHeartbeatTelemetry(meta: HeartbeatTelemetry): void {
  TELEMETRY_BUFFER.push(meta);
  if (TELEMETRY_BUFFER.length > 100) TELEMETRY_BUFFER.shift();
  console.log('[telemetry]', JSON.stringify(meta));
}

// 在 bridge-control.ts 的 doHeartbeat() 里调用:
//   const scheduledAt = state.lastScheduledAt ?? Date.now();
//   recordHeartbeatTelemetry({ type: 'heartbeat', source: 'alarm', scheduledAt, firedAt: Date.now(), delay: Date.now() - scheduledAt, ownerId: getV3Runtime()?.ownerId ?? 'unknown' });
```

**数据收集**：
- 用户启动 mcp-chrome 后跑 30 分钟日常使用
- console.log 输出 telemetry JSON
- 用户截图 console 给 maintainer（或未来自动上报）

**manual smoke runbook** (`docs/wiki/v1.9-smoke-test-runbook.md`)：
1. 安装 mcp-chrome 到用户日常 Chrome
2. 开 Codex，配置 mcp-chrome MCP server
3. 跑 30 分钟日常使用（不必专门测，正常用即可）
4. 复制 console 日志给 maintainer
5. Maintainer 分析 `delay` 分布，识别 outlier

## 5. 测试策略（按 ChatGPT R2 三层）

| Layer | 测试类型 | 覆盖 | v1.9 状态 |
|---|---|---|---|
| 1. Unit | vitest mock | 70% | ✅ v1.8.2 已加 3 tests |
| 2. Integration | Playwright 真实 Chrome | 端到端 | **v1.9 新增** |
| 3. Smoke | 真实用户 Chrome 30min | 真实场景 | **v1.9 新增框架** |

## 6. 影响范围

| 文件 | 类型 | 估计改动 |
|---|---|---|
| `app/chrome-extension/entrypoints/background/keepalive-manager.ts` | modify | +50 lines (state machine + reconcileState) |
| `app/chrome-extension/entrypoints/background/bridge-control.ts` | modify | +5 lines (call reconcileState on alarm) |
| `app/chrome-extension/entrypoints/background/telemetry.ts` | new | ~40 lines |
| `tests/v19/playwright-watchdog.test.ts` | new | ~120 lines |
| `package.json` (`@playwright/test`) | new dep | devDependency |
| `docs/wiki/v1.9-smoke-test-runbook.md` | new | manual runbook |

## 7. 风险

| 风险 | 缓解 |
|---|---|
| Playwright headless 不支持 extension | 必须 `headless: false`，CI matrix 加 `--with-display` |
| 真实 Chrome version drift | Playwright `channel: 'chrome'` 用系统 Chrome stable，与 Codex 一致 |
| Telemetry 噪音（用户日常使用波动） | buffer 100 entries + console.log + manual aggregation |
| CI runner 时间 | 3 tests × 35s ≈ 2 分钟，OK |
| keepalive-manager state machine 复杂度 | 先做简单版（offscreen-only），native-host/SW 后续 |

## 8. Rollout

1. PR #1: keepalive-manager reconcileState + telemetry 框架 + unit tests
2. PR #2: Playwright integration test + CI workflow
3. PR #3: smoke test runbook + 手动验证
4. 文档: wiki 更新
5. close RFC

## 9. Open questions

- reconcileState 是否要包括 native host reconnect？还是只管 offscreen？
  - 倾向：先只管 offscreen（最高频故障），native host reconnect 留给 v1.10
- telemetry 数据是否要自动上报到 GitHub Issue 而不是 console.log？
  - 倾向：v1.9 先 console.log（用户隐私友好），自动上报留 v1.10
- Playwright 是否要在所有 PR 跑还是只在 main merge？
  - 倾向：只在 main 跑（PR 跑会拖慢 review）

## 10. References

- v1.8.2 RFC: `docs/rfcs/2026-08-02-mcp-watchdog-keepalive.md`
- v1.8.2 ChatGPT R2 consult: `tmp/chatgpt_watchdog_R2.txt`
- v1.8.1 RFC: `docs/rfcs/2026-08-02-mcp-session-soft-degradation.md`
- ChatGPT R2 测试策略推荐：三层 (Unit + Integration + Smoke)