# Handoff: chatgpt 两条对话线 + mcp-chrome 实测 — 整合架构

**Recorded**: 2026-08-05
**Context**: 用户同时跟 chatgpt 跑了 2 条对话线 (ranking line + Chrome mode line), 我们 mcp-chrome v1.9.4 跑了 2 个 handoff (debugger-busy + input-mode)。本文档整合三者, 让 Codex Agent 未来能完整恢复上下文。

**配套**:

- `docs/handoff/2026-08-03-debugger-busy-vs-session-expired.md`
- `docs/handoff/2026-08-03-input-mode-decision.md`
- `docs/ai-conversations/2026-08-05-c/6a728b8b-889c-83ea-adfb-84f37ea22ac7.md` (新)

---

## 1. 三条信息线整合

### Line A: chatgpt ranking 对话 (`c/6a72032a-c868-83ea-be2e-ee9961ac5a2e`)

- chatgpt 推荐 5 个项目 + 终极组合架构
- "几百行 TS" 估算 (实测低估)
- mcp-chrome 缺 3 模块 (Chrome daemon manager / CDP reconnect / MCP tool wrapper)
- 我们补充 8 个坑 (Debugger slot / SESSION_EXPIRED / hidden file input / per-account dedup / 16s timeout / ghost text / OCR loss / context loss)

### Line B: chatgpt Chrome mode 对话 (attachment pasted-text.txt, 用户跟 chatgpt 讨论)

- 用户 production 是 **Playwright + system Chrome + `launchPersistentContext`** + dedicated profile
- 不是 mcp-chrome
- chatgpt 最终推荐: **Chrome daemon (port=9222) + Playwright connectOverCDP + Supervisor**
- 4 方案 trade-off 表 (用户用 persistentContext 是次优, chatgpt 最推荐是 Chrome daemon)

### Line C: mcp-chrome v1.9.4 实测 + 2 个 handoff

- v1.9.4 已 release, 17 tools, native-host (port=12306)
- 配套文档: release-runbook / smoke-test-runbook / debugger-busy handoff / input-mode handoff

---

## 2. 三条路径的 trade-off (整合 chatgpt 第二次回复)

| 路径                                      | 隔离 | profile 持久               | debug                   | 掉线风险      | 用户使用现状     |
| ----------------------------------------- | ---- | -------------------------- | ----------------------- | ------------- | ---------------- |
| mcp-chrome (真人 Chrome 共存)             | 低   | 共享                       | 弱 (靠 chrome.debugger) | 高 (F12 冲突) | 探索性           |
| Playwright `launch`                       | 高   | 低 (临时 profile)          | 强                      | 中            | -                |
| Playwright `launchPersistentContext`      | 高   | **高** (dedicated profile) | 强                      | 低            | **production**   |
| Chrome daemon + Playwright connectOverCDP | 最高 | 最高                       | 最强                    | 最低          | chatgpt 最终推荐 |

**关键 insight**: 用户的 production 用 `launchPersistentContext` (次优), chatgpt 第二轮最推荐是 Chrome daemon (最低掉线)。 **mcp-chrome 在这个表里反而是最差的** (隔离低 + profile 共享 + debug 弱 + 掉线高)。

---

## 3. 真实双栈架构图

```
                    Codex Agent
                        |
        +---------------+---------------+
        |                               |
        v                               v
   mcp-chrome (探索)              Playwright (production)
        |                               |
        v                               v
  +-----------+              +---------------------+
  | 用户 Chrome |              | System Chrome binary |
  | (真人 Chrome) |              | + dedicated profile   |
  | + extension  |              | (C:\\chrome-agent-profile) |
  | + native-host |              +---------------------+
  +-----------+                          |
        |                               |
        v                               v
   真人 Chrome tab                 Playwright connectOverCDP
   (chatgpt/gemini/copilot         (launchPersistentContext)
    天然登录态)
        |                               |
        +---------------+---------------+
                        |
                        v
              ChatGPT / Gemini / Copilot
              (复杂多轮 AI 对话)
```

未来架构 (chatgpt 第二轮推荐):

- Chrome daemon (port=9222, persistent profile)
- Playwright connectOverCDP (worker) + mcp-chrome (真人 Chrome 共存) 双栈
- Supervisor 守护 (chrome.exe PID 监控 + reconnect)

---

## 4. mcp-chrome 的实际定位 (基于整合分析)

**不是 daily driver**, 而是:

1. **真人 Chrome 共存场景**: 当用户想用真人 Chrome 接管某些操作 (mcp-chrome 优势)
2. **ChatGPT / Gemini / Copilot 探索性注入**: 我们 8 个坑的 workaround 已经文档化, 是工程化的注入策略
3. **路径示范**: 给 Codex Agent 提供 Chrome 接入的参考实现 (但用户 production 走 Playwright)

**v1.10 真方向** (chatgpt 第二轮 P1):

- **ChatGPT adapter** (stateful site adapter, 把 §0a.x.5 4 轨 + §0a.x.2 物理清空 + §0a.x.8 input mode 固化成代码)
- **tool middleware** (resolve tab -> check blocker -> check session -> execute -> verify, no cache)
- **NOT** daemon manager (chatgpt 同意: 会破坏真人 Chrome 共存产品定位)

---

## 5. 关键决策点 (待用户拍板)

### A. mcp-chrome 的未来定位

- (A1) 维护现有 v1.9.x 不扩展, 仅做 bugfix
- (A2) v1.9.5 加 session recovery + ChatGPT adapter (chatgpt 推荐 P0/P1)
- (A3) 完全转 Playwright persistentContext, 弃 mcp-chrome

### B. 与 Playwright 的关系

- (B1) 双栈共存 (mcp-chrome 探索 + Playwright production)
- (B2) 把 mcp-chrome 17 tools 迁移到 Playwright (废弃 extension 路径)
- (B3) mcp-chrome 收编 Playwright 作为 dependency

### C. daemon manager 的处理

- (C1) 不做 (chatgpt 同意, 会破坏产品定位)
- (C2) 提供 Chrome daemon optional mode (用户可选)
- (C3) 推荐用户在 Playwright 路径用 connectOverCDP

### D. ChatGPT adapter 的范围

- (D1) 只做 ChatGPT (Gemini / Copilot 后续)
- (D2) 全部 AI 网站 (ChatGPT + Gemini + Copilot + Perplexity)
- (D3) 只做 input mode + 4 轨校验, 不做 stateful adapter
