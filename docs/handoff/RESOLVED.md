# Resolved: Pre-existing TS Errors + Handoff corrections (v1.10.3 patch D)

**Recorded**: 2026-08-10
**Context**: 之前 session handoff 提到 7 个 pre-existing TS errors (bridge-control.ts 5 + performance.ts 2)。本次 v1.10.3 patch 验证 — 这些 errors 已被顺手修复, 但 handoff 描述未更新, 容易误导后续 Agent。

---

## 1. 验证结果 (2026-08-10)

```bash
$ cd D:\Documents\VibeCoding\mcp-chrome
$ pnpm -r exec tsc --noEmit
# 0 errors
```

## 2. 历史溯源 (git blame)

### bridge-control.ts 5 errors

- 文件: `app/chrome-extension/entrypoints/background/bridge-control.ts` (handoff 写错了 native-server/, 实际在 chrome-extension background/)
- 引入 commit: `eef5d9f feat: add performance tool` (含 bridge-control.ts 初版, 推测 5 errors 在此 commit 后某次顺手修)
- 当前 commit: `92d1f11 feat(icon): Chrome toolbar 8-state IconManager (v1.10.2)` (最新)
- 最近 6 个改过 bridge-control.ts 的 commits:
  - `92d1f11` v1.10.2 IconManager
  - `ca2294b` v1.9 keepalive reconcileState
  - `e5dcf5a` v1.8.2 watchdog chrome.alarms
  - `53530bf` Phase 3 heartbeat ownerId
  - `9cac9e8` heartbeat on tab lifecycle (60s race fix)
  - `161a7e6` Plan 2.1 + 2.2 bridge register + heartbeat client
  - `fc2e08f` MV3 SW message-queue race fix
  - `2fbdc45` add @ethanwilkins scope
  - `b968944` rename packages -2026 suffix
- **结论 (chatgpt review 修订后)**: Likely resolved during/after `161a7e6` (Plan 2.1 + 2.2) rewrite; no standalone fix commit identified.

### performance.ts 2 errors

- 文件: `app/chrome-extension/entrypoints/background/tools/browser/performance.ts` (15560 bytes)
- 引入 commit: `eef5d9f feat: add performance tool`
- 当前 commit: `eef5d9f` (自引入后无新修改, 即 v1.8 后无 TS error 累积)
- **结论 (chatgpt review 修订后)**: Likely resolved during/after `eef5d9f` 引入 cycle; no standalone fix commit identified.

## 3. 给后续 Agent 的提示

- **不要再相信"pre-existing 7 TS errors"** — 当前实测 0 errors。
- 如果 `pnpm -r exec tsc --noEmit` 返非零, 那是**新引入**的 error, 不是 pre-existing。
- bridge-control.ts 是高频改动文件 (v1.8.1 → v1.10.2 期间改了 9 个 commit), 任何新 patch 加完后跑一遍 typecheck 是 **mandatory**, 不是可选。
- performance.ts 自 v1.8 起没改, 仍是 stable; 但跟其他 file 共用类型 (HeartbeatAgeMs / etc.) 时要小心。

## 4. 如何避免旧 claim 重复误导 (chatgpt review 要求)

- **每次开新 session** 第一动作 (per §9 启动自检): 跑 `pnpm -r exec tsc --noEmit` 拿 0-error 基线, 不要直接信任 handoff 描述。
- **新 patch 加完** 后必须 typecheck (mandatory)。
- **发现 pre-existing 描述与实测不符** 时: 立即写 `docs/handoff/RESOLVED.md` (per pattern), 不要"等下个 patch"。
- **CHANGELOG.md** 同步: "已被顺手修复" 应改为 "previously reported errors are no longer reproducible; fix commit not isolated" (chatgpt review 修订)。

## 5. CHANGELOG 历史同步 (v1.10.3 patch 引用)

已在 [v1.10.2] - 2026-08-07 entry "Notes" 段记录:

> pre-existing bridge-control.ts 类型错误未在本 patch 修复 (已知遗留)。

**修正**: 此条 stale, 实际在 v1.10.2 之前已清 0。v1.10.3 patch D 正式 correction。
