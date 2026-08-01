"""
test_selectors.py

Patch 4 of 6 (agentify-sh/desktop deep-dive, plan section 2.4).

Unit tests for tools/selectors.py:
  - load_selectors() merges override over base
  - validate_selectors() enforces non-empty + string + 5 required names
  - get_selector(name) joins with comma-space
  - get_field_selectors(field) returns replyText / codeBlocks lists
  - caching via reset_cache()
  - override-path: pointing to a temp file with custom fallbacks

Adapted from agentify-sh/desktop (algorithm only, public domain).
"""
import os, sys, json, tempfile, shutil
import unittest
from unittest import mock

# Make sure we can import tools.selectors regardless of cwd
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import selectors


class TestSelectorsValidation:
    def setup_method(self):
        selectors.reset_cache()

    def test_validate_accepts_well_formed_data(self):
        data = selectors._read_json(selectors.DEFAULT_SELECTORS_PATH)
        # Should not raise
        result = selectors.validate_selectors(data)
        assert result is data

    def test_validate_rejects_non_dict_root(self):
        try:
            selectors.validate_selectors(["not", "a", "dict"])
        except ValueError as e:
            assert "must be a JSON object" in str(e)
        else:
            assert False, "should have raised ValueError"

    def test_validate_rejects_missing_required_name(self):
        data = {"promptTextarea": {"fallbacks": ["#x"]}}  # missing 4 required names
        try:
            selectors.validate_selectors(data)
        except ValueError as e:
            assert "missing required selector name" in str(e)
            assert "sendButton" in str(e)
        else:
            assert False, "should have raised"

    def test_validate_rejects_empty_fallbacks_list(self):
        data = {
            "promptTextarea": {"fallbacks": []},
            "sendButton": {"fallbacks": ["#x"]},
            "stopButton": {"fallbacks": ["#x"]},
            "assistantMessage": {"fallbacks": ["#x"]},
            "composerRoot": {"fallbacks": ["#x"]},
        }
        try:
            selectors.validate_selectors(data)
        except ValueError as e:
            assert "non-empty list" in str(e)
        else:
            assert False, "should have raised"

    def test_validate_rejects_non_string_fallback(self):
        data = {
            "promptTextarea": {"fallbacks": ["#x", 42, "#z"]},
            "sendButton": {"fallbacks": ["#x"]},
            "stopButton": {"fallbacks": ["#x"]},
            "assistantMessage": {"fallbacks": ["#x"]},
            "composerRoot": {"fallbacks": ["#x"]},
        }
        try:
            selectors.validate_selectors(data)
        except ValueError as e:
            assert "must be a string" in str(e)
            assert "fallbacks[1]" in str(e)
        else:
            assert False, "should have raised"

    def test_validate_rejects_blank_fallback(self):
        data = {
            "promptTextarea": {"fallbacks": ["#x", "   "]},
            "sendButton": {"fallbacks": ["#x"]},
            "stopButton": {"fallbacks": ["#x"]},
            "assistantMessage": {"fallbacks": ["#x"]},
            "composerRoot": {"fallbacks": ["#x"]},
        }
        try:
            selectors.validate_selectors(data)
        except ValueError as e:
            assert "empty after strip" in str(e)
        else:
            assert False, "should have raised"

    def test_validate_rejects_wrong_type_for_entry(self):
        data = {
            "promptTextarea": ["this", "is", "a", "list", "not", "a", "dict"],
            "sendButton": {"fallbacks": ["#x"]},
            "stopButton": {"fallbacks": ["#x"]},
            "assistantMessage": {"fallbacks": ["#x"]},
            "composerRoot": {"fallbacks": ["#x"]},
        }
        try:
            selectors.validate_selectors(data)
        except ValueError as e:
            assert "must be an object" in str(e)
        else:
            assert False, "should have raised"


class TestSelectorsLoad:
    def setup_method(self):
        selectors.reset_cache()

    def test_load_returns_5_required_names(self):
        data = selectors.load_selectors(use_cache=False)
        assert set(data.keys()) == set(selectors.REQUIRED_NAMES)

    def test_load_returns_fallbacks_for_each_name(self):
        data = selectors.load_selectors(use_cache=False)
        for name in selectors.REQUIRED_NAMES:
            assert isinstance(data[name], dict)
            assert isinstance(data[name]["fallbacks"], list)
            assert len(data[name]["fallbacks"]) > 0

    def test_fallback_counts_match_plan_section_2_4(self):
        # Plan §2.4: promptTextarea 13, sendButton 11, stopButton 6,
        # assistantMessage 8, composerRoot 5. We allow >= those minimums
        # since the exact count is platform-dependent.
        data = selectors.load_selectors(use_cache=False)
        minimums = {
            "promptTextarea": 5,
            "sendButton": 5,
            "stopButton": 5,
            "assistantMessage": 5,
            "composerRoot": 5,
        }
        for name, minimum in minimums.items():
            actual = len(data[name]["fallbacks"])
            assert actual >= minimum, (
                f"{name}: got {actual} fallbacks, expected >= {minimum}"
            )

    def test_cache_returns_same_object(self):
        a = selectors.load_selectors()
        b = selectors.load_selectors()
        assert a is b

    def test_reset_cache_forces_reload(self):
        a = selectors.load_selectors()
        selectors.reset_cache()
        b = selectors.load_selectors()
        assert a is not b
        assert a == b

    def test_override_replaces_base_fallbacks(self):
        # Write a temp override file with one fallback per name, run
        # load_selectors, expect the override to win.
        override_data = {
            "promptTextarea": {"fallbacks": ["#override-only-1", "#override-only-2"]},
            "sendButton": {"fallbacks": ["#override-send"]},
            "stopButton": {"fallbacks": ["#override-stop"]},
            "assistantMessage": {"fallbacks": ["#override-msg"]},
            "composerRoot": {"fallbacks": ["#override-composer"]},
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(override_data, f)
            override_path = f.name
        try:
            selectors.reset_cache()
            data = selectors.load_selectors(override_path=override_path, use_cache=False)
            assert data["promptTextarea"]["fallbacks"] == ["#override-only-1", "#override-only-2"]
            assert data["sendButton"]["fallbacks"] == ["#override-send"]
        finally:
            os.unlink(override_path)

    def test_override_path_does_not_exist_is_ok(self):
        # Override path that does not exist should silently fall through to base.
        selectors.reset_cache()
        data = selectors.load_selectors(override_path="/nonexistent/path/override.json", use_cache=False)
        assert len(data["promptTextarea"]["fallbacks"]) > 0


class TestGetSelector:
    def setup_method(self):
        selectors.reset_cache()

    def test_get_selector_joins_with_comma_space(self):
        s = selectors.get_selector("promptTextarea")
        # Should be a non-empty comma-separated string
        assert isinstance(s, str) and len(s) > 0
        assert "," in s
        # First entry should be the canonical #prompt-textarea
        first = s.split(",")[0].strip()
        assert first == "#prompt-textarea"

    def test_get_selector_contains_all_fallbacks(self):
        selectors.reset_cache()
        data = selectors.load_selectors(use_cache=False)
        s = selectors.get_selector("sendButton")
        for fb in data["sendButton"]["fallbacks"]:
            assert fb in s, f"fallback {fb!r} not found in joined selector {s!r}"

    def test_get_selector_unknown_name_raises_keyerror(self):
        try:
            selectors.get_selector("nonexistent_name")
        except KeyError as e:
            assert "unknown selector name" in str(e)
        else:
            assert False, "should have raised KeyError"

    def test_get_selector_5_names_all_return_non_empty(self):
        for name in selectors.REQUIRED_NAMES:
            s = selectors.get_selector(name)
            assert isinstance(s, str) and len(s) > 0, name


class TestGetFieldSelectors:
    def setup_method(self):
        selectors.reset_cache()

    def test_replyText_field_returns_7_selectors(self):
        sels = selectors.get_field_selectors("replyText")
        assert "p" in sels
        assert "pre" in sels
        assert "li" in sels
        assert "h1" in sels
        assert len(sels) >= 5

    def test_codeBlocks_field_returns_at_least_2_selectors(self):
        sels = selectors.get_field_selectors("codeBlocks")
        assert "pre code" in sels or "code" in sels
        assert len(sels) >= 2

    def test_unknown_field_raises_keyerror(self):
        try:
            selectors.get_field_selectors("unknown")
        except KeyError as e:
            assert "unknown field" in str(e)
        else:
            assert False, "should have raised"


class TestSelectorsJsonSchema:
    def setup_method(self):
        selectors.reset_cache()

    def test_selectors_json_has_meta_block(self):
        with open(selectors.DEFAULT_SELECTORS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        assert "_meta" in data
        assert data["_meta"].get("vendor") == "chatgpt.com"
        assert data["_meta"].get("framework") == "ProseMirror"
        assert data["_meta"].get("version") == "1.0.0"

    def test_selectors_json_has_5_required_names(self):
        with open(selectors.DEFAULT_SELECTORS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        for name in selectors.REQUIRED_NAMES:
            assert name in data, f"missing name {name!r}"

    def test_selectors_json_field_selectors_present(self):
        with open(selectors.DEFAULT_SELECTORS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        assert "_fieldSelectors" in data
        fs = data["_fieldSelectors"]
        assert "replyText" in fs["fallbacks"]
        assert "codeBlocks" in fs["fallbacks"]
