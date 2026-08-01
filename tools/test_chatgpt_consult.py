"""test_chatgpt_consult.py

Post-Step-3 tests for tools/chatgpt_consult.py (thin CLI wrapper around ChatGPTController).

After Step 3, chatgpt_consult.py is ~150 lines of CLI plumbing only:
- argparse (--bundle, --prompt-prefix, --attachment, --context-path, --capture, etc.)
- bundle loading + merge (delegates to tools/bundles.py)
- register_conversation (writes to ~/.codex/ai-conversations.json)
- delegates to ChatGPTController.consult() / .capture() (the actual work)

Tests verify the wiring without launching real Chrome:
  - --help lists all flags
  - consult(args) calls ChatGPTController().consult(tab_id, prompt_text, topic, continue_url)
    with the merged prompt from _apply_bundle_merge
  - capture(args) calls ChatGPTController().capture(url, tab_id, topic)
  - --bundle NAME applies merge; --bundle nonexistent exits 8
  - register_conversation appends to ~/.codex/ai-conversations.json
"""
import os, sys, json, tempfile, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _make_prompt(text="test prompt body"):
    f = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")
    f.write(text)
    f.close()
    return f.name


def _clean(path):
    try:
        os.unlink(path)
    except Exception:
        pass


class TestChatgptConsultCLI:
    def setup_method(self):
        sys.path.insert(0, "tools")
        # Explicitly import so sys.modules is populated even when test runs in isolation.
        import chatgpt_consult
        import chatgpt_controller
        import bundles
        self.cc = chatgpt_consult
        self.ctl = chatgpt_controller
        self.bundles = bundles

    def test_help_lists_all_flags(self):
        r = subprocess.run(
            [sys.executable, "tools/chatgpt_consult.py", "--help"],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )
        assert r.returncode == 0
        for flag in ["--bundle", "--prompt-prefix", "--attachment", "--context-path",
                     "--capture", "--continue", "--register", "--tab-id"]:
            assert flag in r.stdout, "missing flag: " + flag

    def test_consult_delegates_to_chatgpt_controller(self):
        prompt_path = _make_prompt()
        try:
            captured = {}
            real_consult = self.ctl.ChatGPTController.consult

            def fake_consult(self, tab_id, prompt_text, topic, continue_url=None, stop=None):
                captured["tab_id"] = tab_id
                captured["prompt_text"] = prompt_text
                captured["topic"] = topic
                captured["continue_url"] = continue_url
                return ("https://chatgpt.com/c/test", "reply text", "/tmp/handoff.md")

            self.ctl.ChatGPTController.consult = fake_consult
            try:
                # Mimic the CLI's consult(args) flow with a fake args namespace.
                import argparse
                args = argparse.Namespace(
                    prompt=prompt_path,
                    bundle=None, prompt_prefix="",
                    attachment=[], context_path=[],
                    continue_url=None, tab_id=12345,
                    topic=None, register=False, capture=None,
                )
                self.cc.consult(args)
                assert captured["tab_id"] == 12345
                assert captured["prompt_text"] == "test prompt body"
                # Topic is basename without extension; tempfile uses random names like tmpxxxx.md
                import os as _os
                expected_topic = _os.path.splitext(_os.path.basename(prompt_path))[0]
                assert captured["topic"] == expected_topic, (captured["topic"], expected_topic)
            finally:
                self.ctl.ChatGPTController.consult = real_consult
        finally:
            _clean(prompt_path)

    def test_consult_with_bundle_merges_prompt(self):
        prompt_path = _make_prompt("user body")
        try:
            captured = {}
            real_consult = self.ctl.ChatGPTController.consult

            def fake_consult(self, tab_id, prompt_text, topic, continue_url=None, stop=None):
                captured["prompt_text"] = prompt_text
                return ("u", "t", "p")

            self.ctl.ChatGPTController.consult = fake_consult
            try:
                import argparse
                args = argparse.Namespace(
                    prompt=prompt_path,
                    bundle="repo-review",
                    prompt_prefix="", attachment=[], context_path=[],
                    continue_url=None, tab_id=1, topic=None, register=False, capture=None,
                )
                self.cc.consult(args)
                # Bundle prefix prepended; user body present; merged prompt != raw
                assert "Review the repository carefully" in captured["prompt_text"]
                assert "user body" in captured["prompt_text"]
            finally:
                self.ctl.ChatGPTController.consult = real_consult
        finally:
            _clean(prompt_path)

    def test_consult_unknown_bundle_exits_8(self):
        prompt_path = _make_prompt()
        try:
            r = subprocess.run(
                [sys.executable, "tools/chatgpt_consult.py",
                 "--bundle", "no-such-bundle-xyz", prompt_path],
                capture_output=True, text=True,
                cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            )
            assert r.returncode == 8
            assert "FATAL: bundle" in r.stderr
            assert "no-such-bundle-xyz" in r.stderr
        finally:
            _clean(prompt_path)

    def test_capture_delegates_to_chatgpt_controller_capture(self):
        captured = {}
        real_capture = self.ctl.ChatGPTController.capture

        def fake_capture(self, url, tab_id, topic=None):
            captured["url"] = url
            captured["tab_id"] = tab_id
            captured["topic"] = topic
            return ("https://chatgpt.com/c/test", "captured text", "/tmp/handoff.md")

        self.ctl.ChatGPTController.capture = fake_capture
        try:
            import argparse
            args = argparse.Namespace(
                prompt=None, capture="https://chatgpt.com/c/abc",
                bundle=None, prompt_prefix="", attachment=[], context_path=[],
                continue_url=None, tab_id=999, topic="my-topic", register=False,
            )
            self.cc.capture(args)
            assert captured["url"] == "https://chatgpt.com/c/abc"
            assert captured["tab_id"] == 999
            assert captured["topic"] == "my-topic"
        finally:
            self.ctl.ChatGPTController.capture = real_capture

    def test_register_conversation_appends_entry(self):
        import json
        # Create a temp ai-conversations.json
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"conversations": [], "_system_incidents": []}, f)
            state_file = f.name
        try:
            # Patch STATE_FILE in chatgpt_consult
            orig_state = self.cc.STATE_FILE
            self.cc.STATE_FILE = state_file
            try:
                self.cc.register_conversation(
                    "test-proj", "https://chatgpt.com/c/xyz", "topic-x",
                    notes="unit test",
                )
                d = json.load(open(state_file, encoding="utf-8"))
                assert len(d["conversations"]) == 1
                entry = d["conversations"][0]
                assert entry["project"] == "test-proj"
                assert entry["url"] == "https://chatgpt.com/c/xyz"
                assert entry["topic"] == "topic-x"
                assert entry["incident"] is None
                assert entry["notes"] == "unit test"
            finally:
                self.cc.STATE_FILE = orig_state
        finally:
            _clean(state_file)

    def test_register_conversation_returns_false_on_missing_file(self):
        orig_state = self.cc.STATE_FILE
        self.cc.STATE_FILE = "/nonexistent/path/ai-conversations.json"
        try:
            assert self.cc.register_conversation("p", "u", "t") is False
        finally:
            self.cc.STATE_FILE = orig_state

    def test_consult_without_register_skips_register(self):
        prompt_path = _make_prompt()
        try:
            captured_consult = {}
            real_consult = self.ctl.ChatGPTController.consult
            real_register = self.cc.register_conversation

            def fake_consult(self, tab_id, prompt_text, topic, continue_url=None, stop=None):
                captured_consult["called"] = True
                return ("u", "t", "p")
            self.ctl.ChatGPTController.consult = fake_consult
            called_register = []
            def fake_register(*a, **k):
                called_register.append((a, k))
            self.cc.register_conversation = fake_register
            try:
                import argparse
                args = argparse.Namespace(
                    prompt=prompt_path,
                    bundle=None, prompt_prefix="",
                    attachment=[], context_path=[],
                    continue_url=None, tab_id=1, topic=None, register=False, capture=None,
                )
                self.cc.consult(args)
                assert captured_consult.get("called") is True
                assert called_register == []
            finally:
                self.ctl.ChatGPTController.consult = real_consult
                self.cc.register_conversation = real_register
        finally:
            _clean(prompt_path)

    def test_consult_with_register_calls_register(self):
        prompt_path = _make_prompt()
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
                json.dump({"conversations": [], "_system_incidents": []}, f)
                state_file = f.name
            orig_state = self.cc.STATE_FILE
            self.cc.STATE_FILE = state_file
            try:
                captured_consult = {}
                real_consult = self.ctl.ChatGPTController.consult
                def fake_consult(self, tab_id, prompt_text, topic, continue_url=None, stop=None):
                    captured_consult["topic"] = topic
                    return ("https://chatgpt.com/c/test", "reply", "/tmp/handoff.md")
                self.ctl.ChatGPTController.consult = fake_consult
                try:
                    import argparse
                    args = argparse.Namespace(
                        prompt=prompt_path,
                        bundle=None, prompt_prefix="",
                        attachment=[], context_path=[],
                        continue_url=None, tab_id=1, topic="explicit-topic",
                        register=True, capture=None,
                    )
                    self.cc.consult(args)
                    d = json.load(open(state_file, encoding="utf-8"))
                    assert len(d["conversations"]) == 1
                    assert d["conversations"][0]["topic"] == "explicit-topic"
                finally:
                    self.ctl.ChatGPTController.consult = real_consult
            finally:
                self.cc.STATE_FILE = orig_state
                _clean(state_file)
        finally:
            _clean(prompt_path)
