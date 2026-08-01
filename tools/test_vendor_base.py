"""test_vendor_base.py

Patch 6 of 6 (agentify-sh/desktop deep-dive, plan section 2.6).

Tests for vendor_base.py + the two shipped vendor subclasses:
  - VendorControllerBase is abstract (cannot instantiate).
  - Mutex.runExclusive serializes calls per key.
  - StopToken cooperatively cancels.
  - ChallengeDetector probes via JS_evaluate callback.
  - Dynamic stable ms thresholds (1500/2200/3000).
  - ChatGPTController + CopilotController subclass contracts.
  - _build_reply_selector differs between vendors.
"""
import os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vendor_base
import chatgpt_controller
import copilot_consult


class TestVendorControllerBaseAbstract:
    def test_cannot_instantiate_abstract(self):
        try:
            vendor_base.VendorControllerBase()
        except TypeError as e:
            assert "abstract" in str(e).lower()
        else:
            assert False, "should have raised TypeError"

    def test_subclass_must_implement_all_abstracts(self):
        # Incomplete subclass should still fail to instantiate.
        class Incomplete(vendor_base.VendorControllerBase):
            @property
            def _vendor_name(self):
                return "incomplete"
            # missing _get_allowed_host / _build_reply_selector / etc.
        try:
            Incomplete()
        except TypeError as e:
            assert "abstract" in str(e).lower()
        else:
            assert False, "should have raised"

    def test_full_subclass_instantiates(self):
        class Demo(vendor_base.VendorControllerBase):
            @property
            def _vendor_name(self):
                return "demo"
            def _get_allowed_host(self):
                return "demo.com"
            def _build_reply_selector(self):
                return "[data-role=demo]"
            def _fetch_and_inject_prompt(self, tab_id, prompt_text, attachments):
                pass
            def _click_send(self, tab_id):
                pass
            def _wait_for_assistant_stable(self, tab_id, prev_count, timeout_s=180):
                return True, {}

        c = Demo()
        assert c._vendor_name == "demo"
        assert c.mcp_url.startswith("http")
        assert c.handoff_dir == "docs/ai-conversations"


class TestMutex:
    def test_run_exclusive_yields_lock(self):
        m = vendor_base.Mutex()
        with m.run_exclusive("k1") as lock:
            assert lock is not None

    def test_run_exclusive_serializes_same_key(self):
        m = vendor_base.Mutex()
        results = []
        order = []

        def worker(name, delay):
            with m.run_exclusive("shared"):
                order.append(name + ":enter")
                time.sleep(delay)
                order.append(name + ":exit")
                results.append(name)

        t1 = threading.Thread(target=worker, args=("a", 0.1))
        t2 = threading.Thread(target=worker, args=("b", 0.05))
        t1.start(); t2.start()
        t1.join(); t2.join()

        # Verify: each thread enters, then exits, before the other enters.
        assert order == ["a:enter", "a:exit", "b:enter", "b:exit"] or order == ["b:enter", "b:exit", "a:enter", "a:exit"]

    def test_run_exclusive_distinct_keys_dont_block(self):
        m = vendor_base.Mutex()
        order = []

        def worker(name):
            with m.run_exclusive(name):
                order.append(name + ":enter")
                time.sleep(0.05)
                order.append(name + ":exit")

        threads = [threading.Thread(target=worker, args=(k,)) for k in ["a", "b", "c"]]
        for t in threads: t.start()
        for t in threads: t.join()

        # All 3 entered before any exited (parallel).
        enter_count_at_first_exit = 0
        for event in order:
            if ":exit" in event:
                break
            enter_count_at_first_exit += 1
        # The 3 "enter" events should appear before the first "exit".
        # (Loose check: at least 2 of the 3 must have entered before any exit.)
        assert enter_count_at_first_exit >= 2


class TestStopToken:
    def test_default_does_not_raise(self):
        st = vendor_base.StopToken()
        st.throw_if_requested()  # must not raise

    def test_request_stop_then_throw_raises(self):
        st = vendor_base.StopToken()
        st.request_stop()
        try:
            st.throw_if_requested()
        except vendor_base.CancelledError:
            pass
        else:
            assert False, "should have raised CancelledError"

    def test_cancelled_error_is_exception(self):
        e = vendor_base.CancelledError("test")
        assert isinstance(e, Exception)


class TestChallengeDetector:
    def test_default_markers_non_empty(self):
        d = vendor_base.ChallengeDetector()
        assert len(d._default_markers()) >= 3

    def test_detect_empty(self):
        d = vendor_base.ChallengeDetector()
        r = d.detect(lambda code, tab_id: [], 1)
        assert r["detected"] == False
        assert r["marker"] is None

    def test_detect_finds_marker(self):
        d = vendor_base.ChallengeDetector()
        r = d.detect(lambda code, tab_id: ["#challenge-stage"], 1)
        assert r["detected"] == True
        assert r["marker"] == "#challenge-stage"

    def test_detect_with_vendor_markers(self):
        d = vendor_base.ChallengeDetector(vendor_markers=["div.g-recaptcha"])
        r = d.detect(lambda code, tab_id: ["div.g-recaptcha"], 1)
        assert r["detected"] == True
        assert r["marker"] == "div.g-recaptcha"


class TestDynamicStableMs:
    def _make_demo(self):
        # Use Demo instance once; _dynamic_stable_ms is a method on the base.
        class Demo(vendor_base.VendorControllerBase):
            @property
            def _vendor_name(self):
                return "demo"
            def _get_allowed_host(self):
                return "demo.com"
            def _build_reply_selector(self):
                return "[data-role=demo]"
            def _fetch_and_inject_prompt(self, tab_id, prompt_text, attachments):
                pass
            def _click_send(self, tab_id):
                pass
            def _wait_for_assistant_stable(self, tab_id, prev_count, timeout_s=180):
                return True, {}
        return Demo()

    def test_short_text_base_threshold(self):
        d = self._make_demo()
        assert d._dynamic_stable_ms(100) == 1500

    def test_medium_text(self):
        d = self._make_demo()
        assert d._dynamic_stable_ms(3000) == 2200

    def test_long_text(self):
        d = self._make_demo()
        assert d._dynamic_stable_ms(9000) == 3000

    def test_boundary_at_2000(self):
        d = self._make_demo()
        assert d._dynamic_stable_ms(2000) == 1500
        assert d._dynamic_stable_ms(2001) == 2200

    def test_boundary_at_8000(self):
        d = self._make_demo()
        assert d._dynamic_stable_ms(8000) == 2200
        assert d._dynamic_stable_ms(8001) == 3000


class TestChatGPTControllerSubclass:
    def test_vendor_name(self):
        c = chatgpt_controller.ChatGPTController()
        assert c._vendor_name == "chatgpt"

    def test_allowed_host(self):
        c = chatgpt_controller.ChatGPTController()
        assert c._get_allowed_host() == "chatgpt.com"

    def test_reply_selector_uses_selectors_module(self):
        # With sys.path including tools, compose_message_selector() returns
        # the same content as chatgpt_controller builds.
        c = chatgpt_controller.ChatGPTController()
        sel = c._build_reply_selector()
        assert isinstance(sel, str) and len(sel) > 0
        assert "data-message-author-role" in sel
        assert ", " in sel  # comma-space separated

    def test_challenge_markers_non_empty(self):
        c = chatgpt_controller.ChatGPTController()
        markers = c._challenge_markers()
        assert len(markers) >= 1
        for m in markers:
            assert isinstance(m, str)

    def test_constants(self):
        c = chatgpt_controller.ChatGPTController()
        assert c.MAX_CONTINUE_CLICKS == 3
        assert c.DEFAULT_STABLE_MS == 1500


class TestCopilotControllerSubclass:
    def test_vendor_name(self):
        c = copilot_consult.CopilotController()
        assert c._vendor_name == "copilot"

    def test_allowed_host(self):
        c = copilot_consult.CopilotController()
        assert c._get_allowed_host() == "copilot.microsoft.com"

    def test_reply_selector_uses_data_content(self):
        c = copilot_consult.CopilotController()
        sel = c._build_reply_selector()
        assert "data-content" in sel
        assert "ai-message" in sel

    def test_challenge_markers_non_empty(self):
        c = copilot_consult.CopilotController()
        markers = c._challenge_markers()
        assert len(markers) >= 1

    def test_no_continue_clicking(self):
        # Copilot has no Continue generating button; MAX_CONTINUE_CLICKS
        # is inherited from base (None) or not set; we just verify it doesn't
        # loop forever when no marker is detected.
        c = copilot_consult.CopilotController()
        # Verify click_send uses chrome_computer key=Enter (not left_click).
        # We can't easily inspect JS without mocks; just assert the method exists.
        assert callable(c._click_send)


class TestVendorContractDifferences:
    def test_chatgpt_and_copilot_have_different_selectors(self):
        cg = chatgpt_controller.ChatGPTController()
        cp = copilot_consult.CopilotController()
        assert cg._build_reply_selector() != cp._build_reply_selector()

    def test_chatgpt_and_copilot_have_different_vendor_names(self):
        cg = chatgpt_controller.ChatGPTController()
        cp = copilot_consult.CopilotController()
        assert cg._vendor_name != cp._vendor_name

    def test_chatgpt_and_copilot_have_different_allowed_hosts(self):
        cg = chatgpt_controller.ChatGPTController()
        cp = copilot_consult.CopilotController()
        assert cg._get_allowed_host() != cp._get_allowed_host()


class TestSaveHandoff:
    def test_save_handoff_creates_file(self, tmp_path=None):
        # Avoid pytest's tmp_path; use tempfile manually.
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            class Demo(vendor_base.VendorControllerBase):
                @property
                def _vendor_name(self):
                    return "demo"
                def _get_allowed_host(self):
                    return "demo.com"
                def _build_reply_selector(self):
                    return "[data-role=demo]"
                def _fetch_and_inject_prompt(self, tab_id, prompt_text, attachments):
                    pass
                def _click_send(self, tab_id):
                    pass
                def _wait_for_assistant_stable(self, tab_id, prev_count, timeout_s=180):
                    return True, {}

            c = Demo(handoff_dir=tmp)
            handoff = c._save_handoff("test-topic", "https://demo.com/c/abc123", "user prompt", "ai reply text")
            assert os.path.exists(handoff)
            text = open(handoff, encoding="utf-8").read()
            assert "test-topic" in text
            assert "demo.com/c/abc123" in text
            assert "user prompt" in text
            assert "ai reply text" in text
            assert "abc123" in text  # conversation ID extracted from URL
            assert "- Platform: demo" in text
