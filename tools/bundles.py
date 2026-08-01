"""bundles.py
Reusable prompt bundle loader for chatgpt_consult.py --bundle NAME.

Patch 5 of 6 (agentify-sh/desktop deep-dive, plan section 2.5).
Adapted from agentify-sh/desktop (design only, implementation original).
  Source: https://github.com/agentify-sh/desktop/blob/main/bundle-store.mjs
  License: MIT (upstream); design re-implemented for our Python + MCP stack.

A bundle is a JSON file in prompts/bundles/ that pre-collects reusable
context:
  - prompt_prefix: string prepended to the user prompt
  - attachments: list of absolute file paths to attach
  - context_paths: list of absolute directory paths to scan
  - name (key): 1-120 chars, no path traversal characters
  - createdAt / updatedAt: ISO timestamps

Usage:
  python tools/chatgpt_consult.py --bundle repo-review prompt.md
  # equivalent to: typing prompt_prefix + each attachment/context + the prompt

CLI contract (--bundle not found => exit 8):
  bundle not found -> BundleNotFoundError raised, caller exits with code 8.
  This matches HTTP 404 semantics from agentify-sh HTTP API.
"""
import json, os, re

# BUNDLES_DIR is computed relative to project root (cwd ancestor of tools/).
_HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(_HERE)
BUNDLES_DIR = os.path.join(PROJECT_ROOT, "prompts", "bundles")
BUNDLES_GUIDE_FILENAME = 'AGENTS.md'

NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")

_cache = None


class BundleNotFoundError(KeyError):
    """Raised when --bundle NAME does not match any file in BUNDLES_DIR."""
    def __init__(self, name, searched_dir):
        super().__init__("bundle " + repr(name) + " not found in " + searched_dir)
        self.name = name
        self.searched_dir = searched_dir


class BundleValidationError(ValueError):
    """Raised when a bundle JSON fails normalize_bundle validation."""
    pass


def normalize_bundle(data):
    """Fail-fast validation. Returns a copy with defaults applied."""
    if not isinstance(data, dict):
        raise BundleValidationError("bundle root must be a JSON object, got " + type(data).__name__)
    name = data.get("name")
    if not (isinstance(name, str) and name.strip()):
        raise BundleValidationError("bundle.name must be a non-empty string")
    name = name.strip()
    if not NAME_PATTERN.match(name):
        raise BundleValidationError("bundle.name " + repr(name) + " must match " + NAME_PATTERN.pattern)
    prompt_prefix = data.get("promptPrefix") or data.get("prompt_prefix") or ""
    if not isinstance(prompt_prefix, str):
        raise BundleValidationError("bundle.promptPrefix must be a string")
    attachments = data.get("attachments", []) or []
    if not isinstance(attachments, list):
        raise BundleValidationError("bundle.attachments must be a list")
    context_paths = data.get("contextPaths", data.get("context_paths", [])) or []
    if not isinstance(context_paths, list):
        raise BundleValidationError("bundle.contextPaths must be a list")
    for i, p in enumerate(attachments):
        if not (isinstance(p, str) and p.strip()):
            raise BundleValidationError("bundle.attachments[" + str(i) + "] must be a non-empty string")
        if not os.path.isabs(p):
            raise BundleValidationError("bundle.attachments[" + str(i) + "] must be absolute, got " + repr(p))
    for i, p in enumerate(context_paths):
        if not (isinstance(p, str) and p.strip()):
            raise BundleValidationError("bundle.contextPaths[" + str(i) + "] must be a non-empty string")
        if not os.path.isabs(p):
            raise BundleValidationError("bundle.contextPaths[" + str(i) + "] must be absolute, got " + repr(p))
    return {
        "name": name,
        "promptPrefix": prompt_prefix,
        "attachments": list(attachments),
        "contextPaths": list(context_paths),
        "createdAt": data.get("createdAt"),
        "updatedAt": data.get("updatedAt"),
    }


def load_bundle(name, bundles_dir=None, use_cache=True):
    """Read + validate a bundle JSON. Bundle filename must equal name.json."""
    global _cache
    bundles_dir = bundles_dir or BUNDLES_DIR
    cache_key = (name, bundles_dir)
    if use_cache and _cache is not None and cache_key in _cache:
        return _cache[cache_key]
    fpath = os.path.join(bundles_dir, name + ".json")
    if not os.path.exists(fpath):
        raise BundleNotFoundError(name, bundles_dir)
    with open(fpath, encoding="utf-8") as f:
        raw = json.load(f)
    normalized = normalize_bundle(raw)
    if _cache is None:
        _cache = {}
    _cache[cache_key] = normalized
    return normalized


def list_bundles(bundles_dir=None):
    """List all bundle names (filenames without .json) in BUNDLES_DIR,
    excluding AGENTS.md and dotfiles."""
    bundles_dir = bundles_dir or BUNDLES_DIR
    if not os.path.isdir(bundles_dir):
        return []
    names = []
    for entry in sorted(os.listdir(bundles_dir)):
        if not entry.endswith(".json"):
            continue
        if entry.startswith("_") or entry.startswith("."):
            continue
        if entry == BUNDLES_GUIDE_FILENAME:
            continue
        names.append(entry[:-len(".json")])
    return names


def merge_bundle_with_args(bundle, prompt_text="", attachments=None, context_paths=None, prompt_prefix=""):
    """Combine bundle context with CLI args per plan section 2.5.
    Returns a dict with: prompt (joined text), attachments (deduped list,
    bundle first then cli), contextPaths (same), promptPrefix (joined).
    Order: bundle context goes BEFORE cli context (per plan: bundle first).
    """
    attachments = list(attachments or [])
    context_paths = list(context_paths or [])
    bundle_attachments = bundle.get("attachments", []) or []
    bundle_context_paths = bundle.get("contextPaths", []) or []
    # Concatenate bundle first, then CLI; dedup preserving first-seen order.
    merged_attachments = []
    seen = set()
    for p in list(bundle_attachments) + list(attachments):
        if p and p not in seen:
            seen.add(p)
            merged_attachments.append(p)
    merged_context = []
    seen2 = set()
    for p in list(bundle_context_paths) + list(context_paths):
        if p and p not in seen2:
            seen2.add(p)
            merged_context.append(p)
    bundle_prefix = (bundle.get("promptPrefix") or "").strip()
    cli_prefix = (prompt_prefix or "").strip()
    prefixes = [p for p in [bundle_prefix, cli_prefix] if p]
    merged_prefix = chr(10).join(prefixes) if prefixes else ""
    parts = []
    if merged_prefix:
        parts.append(merged_prefix)
    if prompt_text:
        parts.append(prompt_text)
    final_prompt = chr(10).join(parts) if parts else ""
    return {
        "prompt": final_prompt,
        "attachments": merged_attachments,
        "contextPaths": merged_context,
        "promptPrefix": merged_prefix,
    }


def reset_cache():
    """Clear the module-level cache. Used by tests."""
    global _cache
    _cache = None

