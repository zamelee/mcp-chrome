# Bundles Authoring Guide

## What is a Bundle?

A bundle is a JSON file in `prompts/bundles/` that pre-collects reusable
context for chatgpt.com consultations. It lets you write a prompt once and
reuse it with different file attachments / directory context.

## Schema (v1.0.0)

```json
{
  "name": "kebab-case-name",
  "promptPrefix": "string",
  "attachments": ["C:/abs/path/file1.md"],
  "contextPaths": ["C:/abs/dir"],
  "createdAt": "2026-08-01T00:00:00Z",
  "updatedAt": "2026-08-01T00:00:00Z"
}
```

## Validation Rules (tools/bundles.py:normalize_bundle)

- `name` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`
- `attachments` and `contextPaths` items MUST be absolute paths
- All values must be non-empty strings
- Filename MUST equal `{name}.json`

## Merge Order (plan section 2.5)

When you run `chatgpt_consult.py --bundle NAME prompt.md`, the merge is:

1. bundle.contextPaths + CLI --context-path args (dedup, bundle first)
2. bundle.attachments + CLI --attachment args (dedup, bundle first)
3. bundle.promptPrefix + CLI --prompt-prefix (joined with newlines)
4. user prompt body

Final prompt sent to chatgpt.com is: merged_prefix + prompt_body.

## CLI flags (chatgpt_consult.py)

- `--bundle NAME` look up prompts/bundles/{NAME}.json
- `--prompt-prefix STRING` additional prefix appended after bundle prefix
- `--attachment PATH` additional file to attach (can be repeated)
- `--context-path PATH` additional directory to scan (can be repeated)
- Missing bundle => exit code 8 (matches HTTP 404 semantics)

## Authoring Tips

- Keep `promptPrefix` short (< 200 chars). It is prepended every time.
- Use absolute Windows paths (C:/...) relative paths are rejected.
- List `attachments` and `contextPaths` in priority order (most relevant first).
- Add new bundles via `git add prompts/bundles/<name>.json` (no tooling needed).

## Examples (already shipped)

- `repo-review` full repo audit prompt (AGENTS.md + CHANGELOG.md + tools/ + native-server)
- `architecture-doc` architecture doc generation (CHANGELOG + 3 server dirs)

## Internal Architecture

```
prompts/bundles/
  repo-review.json      user-authored
  architecture-doc.json user-authored
  AGENTS.md             this file (committed)
tools/bundles.py       loader (Patch 5 of 6)
  load_bundle(name)
  list_bundles()
  normalize_bundle(data)
  merge_bundle_with_args(bundle, ...)
  reset_cache()
```

Per AGENTS.md section 13: do NOT take upstream PR. Fork-only maintenance.
