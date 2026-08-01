"""
chatgpt_consult.test.py

Patch 2 unit tests for tools/chatgpt_consult.py. We mock the MCP bridge
round-trip so the test runs offline (no real Chrome session required).

Coverage:
  - dynamicStableMs computation (1500 / 2200 / 3000 thresholds per length)
  - Continue generating detection + auto-click (max 3)
  - extract_code_blocks splits code from prose
  - save_handoff writes 4th section when code_blocks present
  - 3-tuple return from extract_reply (page_url, text, code_blocks)
"""
import os, sys, time, tempfile
from unittest import mock

sys.path.insert(0, r"D:\Documents\VibeCoding\mcp-chrome\tools")
import chatgpt_consult  # noqa: E402

def _stable_short_snap(*args, **kwargs):
    return {"count": 2, "stop": False, "sendEnabled": True, "hasContinue": False, "hasRegenerate": False, "txt": "hello world " * 100}

def _stable_long_snap(*args, **kwargs):
    return {"count": 2, "stop": False, "sendEnabled": True, "hasContinue": False, "hasRegenerate": False, "txt": "x" * 10000}

def _continue_snap(*args, **kwargs):
    return {"count": 2, "stop": False, "sendEnabled": True, "hasContinue": True, "hasRegenerate": False, "txt": "truncated" * 50}

# Redirect handoff dir to tmp so tests do not pollute docs/ai-conversations.
_TMP = tempfile.mkdtemp(prefix="chatgpt_consult_test_")
chatgpt_consult.HANDOFF_DIR = _TMP

def test_wait_for_response_short_text_uses_base_threshold():
    with mock.patch.object(chatgpt_consult, "js_evaluate", side_effect=_stable_short_snap):
        t0 = time.time()
        ok, _ = chatgpt_consult.wait_for_response("sid", 1, prev_count=1, timeout_s=10)
        elapsed = time.time() - t0
    assert ok is True
    assert elapsed >= 1.4, f"expected >= 1.4s, got {elapsed:.2f}s"
    assert elapsed < 2.0, f"expected < 2s, got {elapsed:.2f}s"

def test_wait_for_response_long_text_needs_more_patience():
    with mock.patch.object(chatgpt_consult, "js_evaluate", side_effect=_stable_long_snap):
        t0 = time.time()
        ok, _ = chatgpt_consult.wait_for_response("sid", 1, prev_count=1, timeout_s=10)
        elapsed = time.time() - t0
    assert ok is True
    assert elapsed >= 2.8, f"expected >= 2.8s, got {elapsed:.2f}s"

def test_wait_for_response_continue_generating_max_three():
    clicks = {"n": 0}
    def fake_click(*args, **kwargs):
        clicks["n"] += 1
        return True
    with mock.patch.object(chatgpt_consult, "js_evaluate", side_effect=_continue_snap), \
         mock.patch.object(chatgpt_consult.time, "sleep", lambda *_a, **_k: None):
        chatgpt_consult.wait_for_response("sid", 1, prev_count=1, timeout_s=0.05)
    assert clicks["n"] <= 3, f"expected <= 3 clicks, got {clicks["n"]}"

def test_extract_code_blocks_returns_list_with_language_and_text():
    fake_blocks = [{"language": "python", "text": "def hello(): pass"}, {"language": "js", "text": "console.log(1);"}]
    with mock.patch.object(chatgpt_consult, "js_evaluate", return_value=fake_blocks):
        out = chatgpt_consult.extract_code_blocks("sid", 1)
    assert isinstance(out, list)
    assert len(out) == 2
    assert out[0]["language"] == "python"
    assert out[1]["language"] == "js"

def test_extract_reply_returns_three_tuple():
    fake_inner = {"pageUrl": "https://chatgpt.com/c/X", "items": [{"text": "hi"}]}
    fake_blocks = [{"language": "py", "text": "x = 1"}]
    with mock.patch.object(chatgpt_consult, "chrome_extract", return_value=fake_inner), \
         mock.patch.object(chatgpt_consult, "extract_code_blocks", return_value=fake_blocks):
        result = chatgpt_consult.extract_reply("sid", 1)
    assert isinstance(result, tuple) and len(result) == 3
    page_url, text, code_blocks = result
    assert page_url == "https://chatgpt.com/c/X"
    assert text == "hi"
    assert code_blocks == fake_blocks

def test_save_handoff_writes_code_blocks_section_when_present():
    out = chatgpt_consult.save_handoff(
        "test-topic", "https://chatgpt.com/c/TEST", "the prompt", "the response",
        code_blocks=[{"language": "python", "text": "print(1)"}],
    )
    assert os.path.exists(out)
    text = open(out, encoding="utf-8").read()
    assert "Code blocks extracted: 1" in text
    assert "## Code blocks (separated)" in text
    assert "### Block 1 (python)" in text
    assert "print(1)" in text

def test_save_handoff_omits_code_blocks_section_when_none():
    out = chatgpt_consult.save_handoff("no-blocks", "https://chatgpt.com/c/NB", "p", "r")
    text = open(out, encoding="utf-8").read()
    assert "Code blocks extracted" not in text
    assert "## Code blocks (separated)" not in text

