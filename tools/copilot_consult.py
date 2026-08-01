"""copilot_consult.py
Microsoft Copilot consultation controller (Patch 6, second subclass).

Sibling demonstration: shows how a different vendor (Copilot / Bing Chat) maps onto
the same VendorControllerBase API surface as ChatGPTController. Vendor-specific bits:
  - promptTextarea selector (Copilot uses textarea element, NOT ProseMirror contenteditable)
  - send: textarea Enter triggers submit (no click button on Copilot)
  - assistantMessage: [data-content="ai-message"] container
  - No "Continue generating" button (Copilot is single-shot response)

For backward compatibility, the CLI entry point remains tools/chatgpt_consult.py.
This file exists to prove the base-class extraction is genuinely vendor-agnostic:
changing 5 abstract methods + 1 optional hook is enough to support a new vendor.

Usage:
  from tools.copilot_consult import CopilotController
  c = CopilotController()
  url, text, handoff = c.consult(tab_id=12345, prompt_text="hello", topic="smoke")
"""
import sys
from vendor_base import VendorControllerBase, StopToken


class CopilotController(VendorControllerBase):
    """Microsoft Copilot consultation controller (textarea composer)."""

    DEFAULT_STABLE_MS = 1800  # Copilot typically takes longer than chatgpt
    POLL_INTERVAL_S = 0.5

    @property
    def _vendor_name(self):
        return "copilot"

    def _get_allowed_host(self):
        return "copilot.microsoft.com"

    def _build_reply_selector(self):
        # Copilot uses a single container + AI message data attribute.
        Q = chr(34)
        return ("[data-content=" + Q + "ai-message" + Q + "] p, "
                + "[data-content=" + Q + "ai-message" + Q + "] pre, "
                + "[data-content=" + Q + "ai-message" + Q + "] li, "
                + "[data-content=" + Q + "ai-message" + Q + "] h1, "
                + "[data-content=" + Q + "ai-message" + Q + "] h2")

    def _challenge_markers(self):
        # Copilot-specific markers (we don't have first-hand observations; placeholder).
        return [
            "[aria-label*=Captcha i]",
            "[aria-label*=Access denied i]",
        ]

    def _js_focus_and_fill(self):
        Q = chr(34); BS = chr(92)
        return (
            "var ta = document.querySelector(" + Q + "textarea[data-id=composer]" + Q + ");"
            " if (!ta) return JSON.stringify({ok:false, err:" + Q + "no composer" + Q + "});"
            " ta.focus();"
            " ta.value = '';"
            " ta.dispatchEvent(new InputEvent(" + Q + "input" + Q + ", {bubbles: true}));"
            " return JSON.stringify({ok:true});"
        )

    def _js_is_streaming(self):
        Q = chr(34)
        return (
            "return JSON.stringify({streaming: !!document.querySelector(" + Q + "[aria-label=" + Q + "Stop generating" + Q + "]" + Q + ")});"
        )

    def _js_count_messages(self):
        Q = chr(34)
        return (
            "return JSON.stringify({count: document.querySelectorAll(" + Q + "[data-content=" + Q + "ai-message" + Q + "]" + Q + ").length});"
        )

    def _js_wait_snapshot(self):
        Q = chr(34)
        return (
            "return JSON.stringify({"
            "  count: document.querySelectorAll(" + Q + "[data-content=" + Q + "ai-message" + Q + "]" + Q + ").length,"
            "  streaming: !!document.querySelector(" + Q + "[aria-label=" + Q + "Stop generating" + Q + "]" + Q + "),"
            "  txt: (function(){var n=document.querySelectorAll(" + Q + "[data-content=" + Q + "ai-message" + Q + "]" + Q + ");return n.length? n[n.length-1].innerText:" + Q + Q + ";})()"
            "});"
        )

    # ---------- vendor-specific main hooks ----------
    def _fetch_and_inject_prompt(self, tab_id, prompt_text, attachments):
        sid = self._current_sid
        info = self._js_evaluate(sid, self._js_focus_and_fill(), tab_id)
        if not info.get("ok"):
            print("FATAL: focus_and_fill failed: " + str(info), file=sys.stderr); sys.exit(3)
        # Copilot: textarea fill (chrome_computer type)
        self._chrome_computer(sid, "type", tab_id, text=prompt_text)

    def _click_send(self, tab_id):
        sid = self._current_sid
        # Copilot: Enter key in textarea triggers submit (no click button).
        self._chrome_computer(sid, "key", tab_id, key="Enter")

    def _wait_for_assistant_stable(self, tab_id, prev_count, timeout_s=180):
        sid = self._current_sid
        import time
        t0 = time.time()
        stable_ms_required = self.DEFAULT_STABLE_MS
        stable_since = None
        last = {}
        while time.time() - t0 < timeout_s:
            last = self._js_evaluate(sid, self._js_wait_snapshot(), tab_id)
            count = last.get("count", 0) if isinstance(last, dict) else 0
            streaming = last.get("streaming", False) if isinstance(last, dict) else False
            txt = last.get("txt") or "" if isinstance(last, dict) else ""
            if stable_ms_required != self._dynamic_stable_ms(len(txt)):
                stable_ms_required = self._dynamic_stable_ms(len(txt))
                stable_since = None
            if count > prev_count and not streaming and len(txt) > 0:
                if stable_since is None:
                    stable_since = time.time()
                stable_for = (time.time() - stable_since) * 1000
                if stable_for >= stable_ms_required:
                    return True, last
            else:
                stable_since = None
            time.sleep(self.POLL_INTERVAL_S)
        return False, last

    # Override consult() (same pattern as chatgpt_controller.py).
    def consult(self, tab_id, prompt_text, topic, continue_url=None, stop=None):
        stop = stop or StopToken()
        sid = self._ensure_session()
        self._current_sid = sid
        try:
            self._guard_site(sid, tab_id)
            if continue_url:
                self._chrome_navigate(sid, continue_url, tab_id)
            with self._mutex.run_exclusive(tab_id):
                stop.throw_if_requested()
                self._fetch_and_inject_prompt(tab_id, prompt_text, [])
                stop.throw_if_requested()
                self._click_send(tab_id)
                stop.throw_if_requested()
                prev_count = 0
                Q = chr(34)
                mc = self._js_evaluate(sid, "return JSON.stringify({count: document.querySelectorAll(" + Q + "[data-content=" + Q + "ai-message" + Q + "]" + Q + ").length});", tab_id)
                if isinstance(mc, dict):
                    prev_count = mc.get("count", 0)
                stable, info = self._wait_for_assistant_stable(tab_id, prev_count, timeout_s=180)
                stop.throw_if_requested()
                sel = self._build_reply_selector()
                inner = self._chrome_extract(sid, tab_id, selector=sel, fields=[{"name": "text", "selector": "", "type": "text"}])
                url = inner.get("pageUrl", "unknown")
                seen = set()
                parts = []
                for it in inner.get("items", []):
                    t = (it.get("text") or "").strip()
                    if t and t not in seen:
                        seen.add(t)
                        parts.append(t)
                text = chr(10).join(parts)
                self._post_extract_hook(tab_id, code_blocks=[])
                handoff = self._save_handoff(topic, url, prompt_text, text, code_blocks=None)
                return url, text, handoff
        finally:
            self._current_sid = None
