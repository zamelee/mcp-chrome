# Chrome Extension Release Runbook

**Purpose**: 标准流程把 git tag 转化为用户 Chrome 里的扩展版本。三层版本号（git tag / package.json / manifest.json）必须同步。

**触发场景**: 新 release commit 推到远端后, 用户在本地 reload 扩展。

---

## 背景: 三层版本号

```
git tag (远端权威)
  v1.9.1
    ↓
package.json (WXT 读取, source of truth)
  "version": "1.9.1"
    ↓
pnpm build (WXT 同步到 manifest)
  .output/chrome-mv3/manifest.json
  "version": "1.9.1"
```

任何一层不同步 → 用户 Chrome extensions page 显示旧版本, 不知道是 git 还是本地 build 错了。

## 标准 release 流程 (5 步)

### 1. 切到 release tag

```bash
cd D:\Documents\VibeCoding\mcp-chrome
git fetch --tags
git checkout v1.9.1
```

### 2. 装依赖

```bash
cd app/chrome-extension
pnpm install --frozen-lockfile
```

新 release 经常带新 devDependency (e.g. `@playwright/test` 在 v1.9.1), 必须重装。

### 3. Build 重新生成 manifest

```bash
pnpm build
```

这一步把 `package.json` 的 version 写到 `.output/chrome-mv3/manifest.json`。**`.output` 是 `.gitignore`, 必须本地 build**。

### 4. 验证三层同步

```bash
node -e "
const pkg = require('./package.json').version;
const man = require('./.output/chrome-mv3/manifest.json').version;
console.log('package.json:', pkg);
console.log('manifest.json:', man);
if (pkg !== man) { console.error('MISMATCH'); process.exit(1); }
"
```

期望输出:
```
package.json: 1.9.1
manifest.json: 1.9.1
```

如果 mismatch:
- `pnpm build` 没跑 → 跑
- `package.json` 没 bump → bump 到正确 version
- git tag 跟 source 不匹配 → amend commit + force push tag

### 5. Chrome reload

1. Chrome → `chrome://extensions`
2. 找 "猫娘 Chrome MCP Server"
3. 点 **重新加载** 图标 (rotate-arrow icon)
4. 确认版本号 = step 4 验证的 version

---

## 常见坑

| 现象 | 原因 | 修复 |
|---|---|---|
| extensions page 显示旧版本, 但 `git tag` 是新的 | 没跑 `pnpm build`, `.output` 还是上次 build 的 | 跑 step 3 |
| `pnpm build` 后 manifest 还是旧 | `wxt.config.ts` 不读 `package.json` 的 version | 检查 `wxt.config.ts` 是否覆盖 manifest (e.g. `manifest.version` 显式设置) |
| CI 报 version mismatch | commit 时漏 bump `package.json` | amend commit + bump `package.json` + amend again + force push |
| manifest 显示 `1.9.0` 但 tag 是 `v1.9.1` | `package.json` 没 bump 到 `1.9.1` (跟 v1.9.0 PR 同一 source code) | bump `package.json` 到 `1.9.1`, amend commit, force push tag |

## CI 自动化 (v1.9.1+)

`.github/workflows/build-consistency.yml` 在 PR/push 时自动:
1. `pnpm install`
2. `pnpm build`
3. 断言 `manifest.version === package.json.version`

如果 mismatch, job fail, PR blocked, 提示 "bump package.json 或 amend commit"。

## 给 maintainer 的 checklist (release 时)

```
[ ] 1. `git tag -a vX.Y.Z -m "..."` (annotated tag, 附 RFC 链接)
[ ] 2. 确认 `app/chrome-extension/package.json` 是 X.Y.Z (跟 tag 一致)
[ ] 3. `git push origin master --tags` (不要 force, 自然 push)
[ ] 4. 在 GitHub Releases 写 release notes (从 CHANGELOG 复制 entry)
[ ] 5. 更新 `docs/wiki/v1.X.Y-release-checklist.md` (如果存在)
```

## 给用户的 checklist (reload 前)

```
[ ] 1. `git checkout vX.Y.Z` (跟当前 Chrome extensions page 显示的版本对比)
[ ] 2. `cd app/chrome-extension && pnpm install && pnpm build`
[ ] 3. 验证 manifest version (用 step 4 node -e 命令)
[ ] 4. Chrome reload 扩展
[ ] 5. 确认 extensions page version = git tag
```

## 为什么不把 `.output` 入 git

`.output/chrome-mv3/` 是 build artifact, 跟 `dist/` `node_modules/` 一样应该 gitignore:
- 大 (几个 MB)
- 平台相关 (Chrome stable 的 .output 在 Firefox 不能用)
- 跟 source code 不同步风险高 (本地 build 没 commit)

正确做法是 CI build 后用 GitHub Releases 分发 `.zip`, 用户下下来 Load Unpacked 即可。