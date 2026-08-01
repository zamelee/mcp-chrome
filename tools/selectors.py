"""selectors.py
CSS selector fallback chain loader for chatgpt.com ProseMirror composer.

Patch 4 of 6 (agentify-sh/desktop deep-dive, plan section 2.4).
Adapted from agentify-sh/desktop (algorithm only, public domain).
  Source: https://github.com/agentify-sh/desktop/blob/main/selectors.json

Architecture:
  - tools/selectors.json is the canonical fallback list (committed to git).
  - ~/.codex/selectors.override.json is per-user / per-environment override
    (git-ignored). Each element override REPLACES base fallbacks.
  - load_selectors() merges: override > canonical.
  - get_selector(name) returns comma-joined CSS for querySelector / querySelectorAll.
  - validate_selectors() enforces: each name non-empty, each fallback non-empty.

Usage:
  from tools.selectors import get_selector
  ed = js_evaluate(sid, f"return document.querySelector({get_selector(name)!r});", tab_id)
"""
import json, os

DEFAULT_SELECTORS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "selectors.json")
OVERRIDE_PATH = os.path.expanduser("~/.codex/selectors.override.json")
_cache = None

REQUIRED_NAMES = ("promptTextarea", "sendButton", "stopButton", "assistantMessage", "composerRoot")


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def validate_selectors(data):
    if not isinstance(data, dict):
        raise ValueError(f"selectors root must be a JSON object, got {type(data).__name__}")
    for name in REQUIRED_NAMES:
        if name not in data:
            raise ValueError(f"missing required selector name: {name!r}")
        entry = data[name]
        if not isinstance(entry, dict):
            raise ValueError(f"selector {name!r} must be an object, got {type(entry).__name__}")
        fallbacks = entry.get("fallbacks")
        if not isinstance(fallbacks, list) or len(fallbacks) == 0:
            raise ValueError(f"selector {name!r}.fallbacks must be a non-empty list")
        for i, fb in enumerate(fallbacks):
            if not isinstance(fb, str):
                raise ValueError(f"selector {name!r}.fallbacks[{i}] must be a string, got {type(fb).__name__}")
            s = fb.strip()
            if not s:
                raise ValueError(f"selector {name!r}.fallbacks[{i}] is empty after strip")
    return data


def load_selectors(override_path=OVERRIDE_PATH, base_path=DEFAULT_SELECTORS_PATH, use_cache=True):
    global _cache
    if use_cache and _cache is not None:
        return _cache
    base = _read_json(base_path)
    base = validate_selectors(base)
    merged = {}
    for name in REQUIRED_NAMES:
        merged[name] = {
            "description": base[name].get("description", ""),
            "fallbacks": list(base[name]["fallbacks"]),
        }
    if override_path and os.path.exists(override_path):
        override = _read_json(override_path)
        override = validate_selectors(override)
        for name in REQUIRED_NAMES:
            if name in override and "fallbacks" in override[name]:
                merged[name]["fallbacks"] = list(override[name]["fallbacks"])
                if "description" in override[name]:
                    merged[name]["description"] = override[name]["description"]
    _cache = merged
    return merged


def get_selector(name, override_path=OVERRIDE_PATH, base_path=DEFAULT_SELECTORS_PATH):
    if name not in REQUIRED_NAMES:
        raise KeyError(f"unknown selector name: {name!r}; valid: {REQUIRED_NAMES}")
    data = load_selectors(override_path=override_path, base_path=base_path)
    fallbacks = data[name]["fallbacks"]
    return ", ".join(s.strip() for s in fallbacks if s and s.strip())


def get_field_selectors(field):
    if field not in ("replyText", "codeBlocks"):
        raise KeyError(f"unknown field: {field!r}; valid: replyText, codeBlocks")
    base = _read_json(DEFAULT_SELECTORS_PATH)
    fs_block = base.get("_fieldSelectors", {}).get("fallbacks", {})
    return list(fs_block.get(field, []))


def get_primary_fallback(name, override_path=OVERRIDE_PATH, base_path=DEFAULT_SELECTORS_PATH):
    """Return the FIRST (canonical) fallback selector for `name`. Use this when
    you need ONE selector to anchor JS template composition (e.g. building a
    message selector from one container + multiple field selectors). Raises
    KeyError if name is unknown or has no fallbacks."""
    if name not in REQUIRED_NAMES:
        raise KeyError(f"unknown selector name: {name!r}; valid: {REQUIRED_NAMES}")
    data = load_selectors(override_path=override_path, base_path=base_path)
    fallbacks = data[name]["fallbacks"]
    if not fallbacks:
        raise ValueError(f"selector {name!r} has no fallbacks")
    return fallbacks[0].strip()


def compose_message_selector(override_path=OVERRIDE_PATH, base_path=DEFAULT_SELECTORS_PATH):
    """Build the assistantMessage REPLY_SELECTOR by combining:
      - the primary (first) assistantMessage fallback as the container anchor
      - one selector per replyText field, appended as `<container> <field>`
    Returns a comma-separated CSS string suitable for querySelectorAll (matches
    first occurrence). Mirrors the original hardcoded format."""
    container = get_primary_fallback("assistantMessage", override_path=override_path, base_path=base_path)
    fields = get_field_selectors("replyText")
    parts = [f"{container} {f}" for f in fields if f and f.strip()]
    return ", ".join(parts)


def reset_cache():
    global _cache
    _cache = None
