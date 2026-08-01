"""chatgpt_controller.py
ChatGPT-specific subclass of VendorControllerBase (Patch 6).

Adapts the shared MCP transport + consult() orchestrator from vendor_base.py to
chatgpt.com's ProseMirror composer. Vendor-specific bits:
  - promptTextarea selector (ProseMirror contenteditable)
  - send button + click + Enter behavior
  - Continue generating auto-click (max 3)
  - assistantMessage selector (data-message-author-role="assistant")

For backward compatibility, tools/chatgpt_consult.py remains the entry-point CLI
with its own self-contained flow. This controller is the canonical "subclass-of-base"
demonstration that future vendors (copilot, gemini, ...) can pattern-match.

Usage:
  from tools.chatgpt_controller import ChatGPTController
  c = ChatGPTController()
  url, text, handoff = c.consult(tab_id=12345, prompt_text="hello", topic="smoke")
"""
import os, sys, time
from vendor_base import VendorControllerBase, StopToken
try:
    from selectors import compose_message_selector
    _SELECTORS_AVAILABLE = True
except ImportError:
    _SELECTORS_AVAILABLE = False


class ChatGPTController(VendorControllerBase):
    """ChatGPT.com consultation controller (ProseMirror composer)."""

    MAX_CONTINUE_CLICKS = 3
    DEFAULT_STABLE_MS = 1500
    POLL_INTERVAL_S = 0.4

    @property
    def _vendor_name(self):
        return "chatgpt"

    def _get_allowed_host(self):
        return "chatgpt.com"

    def _build_reply_selector(self):
        if _SELECTORS_AVAILABLE:
            return compose_message_selector()
        # Fallback (used when tools/selectors.py not on sys.path).
        Q = chr(34)
        container = "[data-message-author-role=" + Q + "assistant" + Q + "]"
        fields = ["p", "pre", "li", "h1", "h2", "h3", "h4"]
        return ",".join(container + " " + f for f in fields)

    def _challenge_markers(self):
        # ChatGPT-specific challenges seen in production.
        Q = chr(34)
        return [
            "div[data-testid=challenge]",
            "[aria-label*=" + Q + "rate limit" + Q + " i]",
            "[aria-label*=" + Q + "too many requests" + Q + " i]",
        ]

    # ---------- vendor-specific JS templates (use chr() to avoid escape hell) ----------
    def _js_focus_and_clear(self):
        Q = chr(34); BS = chr(92)
        return (
            "var ed = document.querySelector(" + Q + "#prompt-textarea" + Q + ");"
            " if (!ed) return JSON.stringify({ok:false, err:" + Q + "no editor" + Q + "});"
            " ed.focus();"
            " ed.innerHTML = " + Q + "<p><br class=" + BS + Q + "ProseMirror-trailingBreak" + BS + Q + "></p>" + Q + ";"
            " ed.dispatchEvent(new InputEvent(" + Q + "input" + Q + ", {bubbles: true}));"
            " return JSON.stringify({ok:true, pCount: document.querySelectorAll(" + Q + "#prompt-textarea p" + Q + ").length});"
        )

    def _js_click_send(self):
        Q = chr(34); BS = chr(92)
        return (
            "var btn = document.querySelector(" + Q + "[data-testid=" + BS + Q + "send-button" + BS + Q + "]" + Q + ");"
            " if (!btn) return JSON.stringify({ok:false});"
            " var r = btn.getBoundingClientRect();"
            " return JSON.stringify({ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});"
        )

    def _js_continue_probe(self):
        Q = chr(34)
        return (
            "var allBtns = document.querySelectorAll(" + Q + "button" + Q + ");"
            " var contBtn = null;"
            " for (var i=0;i<allBtns.length;i++){var t=(allBtns[i].innerText||" + Q + Q + ").trim();"
            " if(t.indexOf(" + Q + "Continue generating" + Q + ")>=0){contBtn=allBtns[i];break;}}"
            " if (!contBtn) return JSON.stringify({ok:false});"
            " var r = contBtn.getBoundingClientRect();"
            " return JSON.stringify({ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});"
        )

    def _js_wait_snapshot(self):
        Q = chr(34); BS = chr(92)
        return (
            "var nodes = document.querySelectorAll(" + Q + "[data-message-author-role]" + Q + ");"
            " var last = nodes[nodes.length - 1];"
            " var lastRole = last ? last.getAttribute(" + Q + "data-message-author-role" + Q + ") : null;"
            " var stopBtn = document.querySelector(" + Q + "button[aria-label=" + BS + Q + "Stop generating" + BS + Q + "]" + Q + ");"
            " var contBtn = null; var allBtns = document.querySelectorAll(" + Q + "button" + Q + ");"
            " for (var i=0;i<allBtns.length;i++){var t=(allBtns[i].innerText||" + Q + Q + ").trim();"
            " if(t.indexOf(" + Q + "Continue generating" + Q + ")>=0){contBtn=allBtns[i];break;}}"
            " var sendEnabled = !!document.querySelector(" + Q + "#prompt-textarea" + Q + ");"
            " var txt=" + Q + Q + ";"
            " if (last && lastRole===" + Q + "assistant" + Q + ") { txt = last.innerText || " + Q + Q + "; }"
            " return JSON.stringify({count: nodes.length, stop: !!stopBtn, sendEnabled: sendEnabled, hasContinue: !!contBtn, lastRole: lastRole, txt: txt});"
        )

    # ---------- vendor-specific main hooks ----------
    def _fetch_and_inject_prompt(self, tab_id, prompt_text, attachments):
        sid = self._current_sid
        info = self._js_evaluate(sid, self._js_focus_and_clear(), tab_id)
        if not info.get("ok"):
            print("FATAL: focus_and_clear failed: " + str(info), file=sys.stderr); sys.exit(3)
        self._chrome_computer(sid, "type", tab_id, text=prompt_text)

    def _click_send(self, tab_id):
        sid = self._current_sid
        info = self._js_evaluate(sid, self._js_click_send(), tab_id)
        if not info.get("ok"):
            print("FATAL: send button not found: " + str(info), file=sys.stderr); sys.exit(4)
        x = info["x"]; y = info["y"]
        self._chrome_computer(sid, "left_click", tab_id, coordinates={"x": x, "y": y})

    def _wait_for_assistant_stable(self, tab_id, prev_count, timeout_s=180):
        sid = self._current_sid
        t0 = time.time()
        stable_ms_required = self.DEFAULT_STABLE_MS
        stable_since = None
        continue_clicks = 0
        stop_gone_since = None
        last = {}
        while time.time() - t0 < timeout_s:
            last = self._js_evaluate(sid, self._js_wait_snapshot(), tab_id)
            count = last.get("count", 0) if isinstance(last, dict) else 0
            stop = last.get("stop") if isinstance(last, dict) else None
            has_continue = last.get("hasContinue") if isinstance(last, dict) else None
            txt = last.get("txt") or "" if isinstance(last, dict) else ""
            dynamic_ms = self._dynamic_stable_ms(len(txt))
            if stable_ms_required != dynamic_ms:
                stable_ms_required = dynamic_ms
                stable_since = None
            if has_continue and continue_clicks < self.MAX_CONTINUE_CLICKS and not stop:
                probe_info = self._js_evaluate(sid, self._js_continue_probe(), tab_id)
                if probe_info.get("ok"):
                    cx = probe_info["x"]; cy = probe_info["y"]
                    self._chrome_computer(sid, "left_click", tab_id, coordinates={"x": cx, "y": cy})
                    continue_clicks += 1
                    time.sleep(self.POLL_INTERVAL_S)
                    continue
            if count > prev_count and not stop and len(txt) > 0:
                if stop_gone_since is None:
                    stop_gone_since = time.time()
                if stable_since is None:
                    stable_since = time.time()
                stable_for = (time.time() - stable_since) * 1000
                stop_gone_for = ((time.time() - stop_gone_since) * 1000) if stop_gone_since else 0
                if stable_for >= stable_ms_required and (stop_gone_for >= 800 or stop_gone_for == 0):
                    return True, last
            else:
                stable_since = None
                stop_gone_since = None
            time.sleep(self.POLL_INTERVAL_S)
        return False, last

    # Override consult() to pass current sid to hooks (which the base class does not).
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
                mc = self._js_evaluate(sid, "return JSON.stringify({count: document.querySelectorAll(" + Q + "[data-message-author-role]" + Q + ").length});", tab_id)
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


def cli_consult(prompt_path, tab_id, topic=None):
    """Convenience: load a prompt file, run consult, print summary."""
    ctl = ChatGPTController()
    prompt_text = open(prompt_path, encoding="utf-8").read().strip()
    if not topic:
        topic = os.path.basename(prompt_path).rsplit(".", 1)[0][:60]
    return ctl.consult(tab_id=tab_id, prompt_text=prompt_text, topic=topic)
