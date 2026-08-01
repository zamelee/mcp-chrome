"""vendor_base.py
Per-vendor consultation controller base class.

Patch 6 of 6 (agentify-sh/desktop deep-dive, plan section 2.6).
Adapted from agentify-sh/desktop (design only, public domain).
  Source: https://github.com/agentify-sh/desktop/blob/main/chatgpt-controller.mjs
  (per-vendor controller pattern; our re-implementation in Python is original).

Why a base class?
  - chatgpt + copilot share the same MCP-bridge plumbing.
  - chatgpt + copilot share consult() main flow.
  - vendor-specific bits stay in subclass: selector chain, send trigger, etc.

Subclass contract (abstract methods):
  - _vendor_name -> str
  - _get_allowed_host() -> str
  - _build_reply_selector() -> str
  - _fetch_and_inject_prompt(tab_id, prompt_text, attachments) -> None
  - _click_send(tab_id) -> None
  - _wait_for_assistant_stable(tab_id, prev_count, timeout_s) -> (bool, dict)

Optional hooks (subclass may override):
  - _post_extract_hook(tab_id, code_blocks) -> None
  - _challenge_markers() -> list[str]

Shared infrastructure (concrete in base):
  - Mutex.runExclusive: ensures single-flight consultation per tab
  - StopToken: cooperative cancel chain (raise CancelledError)
  - MCP transport: post / parse_sse / js_evaluate / chrome_navigate / chrome_computer / chrome_extract
  - Save handoff via _save_handoff()
  - ChallengeDetector: shared anti-bot signal detection (vendor-customized markers)
"""
import json, os, sys, time, urllib.request
from abc import ABC, abstractmethod


class CancelledError(Exception):
    """Raised by StopToken.throw_if_requested() to abort an in-flight consultation."""
    pass


class StopToken:
    """Cooperative cancellation. Set .cancelled = True to abort a running consult()."""

    def __init__(self):
        self.cancelled = False

    def request_stop(self):
        self.cancelled = True

    def throw_if_requested(self):
        if self.cancelled:
            raise CancelledError("consultation cancelled by StopToken")


class Mutex:
    """Single-flight mutex keyed by an arbitrary hashable (typically tab_id)."""

    def __init__(self):
        self._locks = {}

    def _get_lock(self, key):
        if key not in self._locks:
            self._locks[key] = _make_lock()
        return self._locks[key]

    def run_exclusive(self, key):
        return self._get_lock(key)


def _make_lock():
    """Create a context-manager lock. threading.Lock preferred, no-op fallback."""
    try:
        import threading
        return threading.Lock()
    except Exception:
        class _NoopLock:
            def __enter__(self):
                return self
            def __exit__(self, exc_type, exc, tb):
                return False
        return _NoopLock()


class ChallengeDetector:
    """Detect vendor anti-bot challenges (CAPTCHA / rate-limit)."""

    def __init__(self, vendor_markers=None):
        self._vendor_markers = list(vendor_markers or [])

    def _default_markers(self):
        return [
            "div.g-recaptcha",
            "#challenge-stage",
            "[data-testid=rate-limit-banner]",
            "iframe[src*=hcaptcha]",
        ]

    def detect(self, js_evaluate_fn, tab_id):
        """Returns dict: {detected, marker, snippet}."""
        markers = self._vendor_markers or self._default_markers()
        Q = chr(34)
        BS = chr(92)
        sel_list = "[" + ",".join(Q + m.replace(Q, BS + Q) + Q for m in markers) + "]"
        js_lines = [
            "var m = " + sel_list + ";",
            "var hits = m.filter(function(s){return !!document.querySelector(s);});",
            "return JSON.stringify(hits);",
        ]
        js = chr(10).join(js_lines)
        raw = js_evaluate_fn(js, tab_id)
        hits = []
        if isinstance(raw, list):
            hits = raw
        elif isinstance(raw, dict):
            hits = raw.get("hits") or []
        if hits:
            return {"detected": True, "marker": hits[0], "snippet": None}
        return {"detected": False, "marker": None, "snippet": None}


class VendorControllerBase(ABC):
    """Abstract base class shared by all per-vendor consultation controllers."""

    MCP_PROTOCOL_VERSION = "2024-11-05"

    def __init__(self, mcp_url=None, handoff_dir="docs/ai-conversations"):
        self.mcp_url = mcp_url or os.environ.get("MCP_URL", "http://127.0.0.1:12306/mcp")
        self.handoff_dir = handoff_dir
        self._mutex = Mutex()
        self._detector = ChallengeDetector()

    @property
    @abstractmethod
    def _vendor_name(self):
        ...  # e.g. "chatgpt" / "copilot"

    @abstractmethod
    def _get_allowed_host(self):
        ...  # e.g. "chatgpt.com" / "copilot.microsoft.com"

    @abstractmethod
    def _build_reply_selector(self):
        ...  # comma-joined CSS

    @abstractmethod
    def _fetch_and_inject_prompt(self, tab_id, prompt_text, attachments):
        ...

    @abstractmethod
    def _click_send(self, tab_id):
        ...

    @abstractmethod
    def _wait_for_assistant_stable(self, tab_id, prev_count, timeout_s=180):
        ...

    def _post_extract_hook(self, tab_id, code_blocks):
        return None

    def _challenge_markers(self):
        return []

    def _post(self, payload, headers=None):
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if headers:
            h.update(headers)
        req = urllib.request.Request(self.mcp_url, data=json.dumps(payload).encode(), headers=h)
        resp = urllib.request.urlopen(req, timeout=30)
        sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
        return sid, resp.read().decode()

    def _parse_sse(self, body):
        for line in body.splitlines():
            if line.startswith("data: "):
                return line[len("data: "):]
        return body

    def _ensure_session(self):
        sid, body = self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": self.MCP_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": self._vendor_name + "-controller", "version": "1.0"}}})
        if not sid:
            print("init failed:", body[:300], file=sys.stderr); sys.exit(1)
        return sid

    def _js_evaluate(self, sid, code, tab_id, retries=2):
        last_err = None
        for _ in range(retries):
            try:
                _, body = self._post({"jsonrpc": "2.0", "id": 99, "method": "tools/call", "params": {"name": "chrome_javascript", "arguments": {"tabId": tab_id, "code": code}}}, headers={"Mcp-Session-Id": sid})
                pkt = json.loads(self._parse_sse(body))
                inner_text = pkt["result"]["content"][0]["text"]
                inner = json.loads(inner_text)
                return json.loads(inner["result"])
            except Exception as e:
                last_err = str(e)
                time.sleep(0.5)
        return {"error": last_err or "unknown", "code_snippet": code[:80]}

    def _chrome_navigate(self, sid, url, tab_id):
        _, body = self._post({"jsonrpc": "2.0", "id": 96, "method": "tools/call", "params": {"name": "chrome_navigate", "arguments": {"url": url, "tabId": tab_id}}}, headers={"Mcp-Session-Id": sid})
        return json.loads(self._parse_sse(body))

    def _chrome_computer(self, sid, action, tab_id, **kwargs):
        args = {"action": action}; args.update(kwargs); args["tabId"] = tab_id
        _, body = self._post({"jsonrpc": "2.0", "id": 97, "method": "tools/call", "params": {"name": "chrome_computer", "arguments": args}}, headers={"Mcp-Session-Id": sid})
        pkt = json.loads(self._parse_sse(body))
        inner_text = pkt["result"]["content"][0]["text"]
        return json.loads(inner_text) if inner_text.startswith("{") else pkt

    def _chrome_extract(self, sid, tab_id, selector, fields):
        _, body = self._post({"jsonrpc": "2.0", "id": 95, "method": "tools/call", "params": {"name": "chrome_extract", "arguments": {"tabId": tab_id, "selector": selector, "fields": fields}}}, headers={"Mcp-Session-Id": sid})
        pkt = json.loads(self._parse_sse(body))
        return json.loads(pkt["result"]["content"][0]["text"])

    def _guard_site(self, sid, tab_id):
        info = self._js_evaluate(sid, "return JSON.stringify({host: location.host, url: location.href});", tab_id)
        if "error" in info:
            print("site probe failed:", info.get("error", "unknown"), file=sys.stderr); sys.exit(2)
        host = info.get("host", "")
        allowed = self._get_allowed_host()
        if allowed not in host:
            print("ERROR: this controller only works on " + allowed + "; current host is " + host, file=sys.stderr); sys.exit(2)

    def _save_handoff(self, topic, url, prompt_text, response_text, code_blocks=None):
        os.makedirs(self.handoff_dir, exist_ok=True)
        import re
        date_str = time.strftime("%Y-%m-%d")
        safe = re.sub(r"[^a-zA-Z0-9-]+", "-", topic.lower())[:60].strip("-")
        out = os.path.join(self.handoff_dir, date_str + "-" + safe + ".md")
        with open(out, "w", encoding="utf-8") as f:
            conv_id = url.rsplit(chr(47), 1)[-1]
            f.write("# " + topic + chr(10) + chr(10))
            f.write("- Date: " + date_str + chr(10))
            f.write("- Platform: " + self._vendor_name + chr(10))
            f.write("- URL: " + url + chr(10))
            f.write("- Conversation ID: " + conv_id + chr(10))
            f.write("- Response length: " + str(len(response_text)) + " chars" + chr(10) + chr(10))
            f.write("---" + chr(10) + chr(10))
            f.write("## Prompt (verbatim)" + chr(10) + chr(10))
            f.write(prompt_text)
            f.write(chr(10) + chr(10) + "---" + chr(10) + chr(10))
            f.write("## " + self._vendor_name.capitalize() + " reply (verbatim)" + chr(10) + chr(10))
            f.write(response_text)
            f.write(chr(10))
            if code_blocks:
                f.write(chr(10) + chr(10) + "---" + chr(10) + chr(10))
                f.write("## Code blocks (separated)" + chr(10) + chr(10))
                f.write("- Code blocks extracted: " + str(len(code_blocks)) + chr(10) + chr(10))
                for idx, blk in enumerate(code_blocks, start=1):
                    lang = blk.get("language", "text")
                    text_b = blk.get("text", "")
                    f.write("### Block " + str(idx) + " (" + lang + ")" + chr(10) + chr(10))
                    f.write(chr(96)*3 + lang + chr(10))
                    f.write(text_b)
                    f.write(chr(10) + chr(96)*3 + chr(10))
        return out

    def _dynamic_stable_ms(self, txt_len):
        if txt_len > 8000: return 3000
        if txt_len > 2000: return 2200
        return 1500

    def _check_challenge(self, sid, tab_id):
        self._detector._vendor_markers = self._challenge_markers()
        return self._detector.detect(self._js_evaluate, tab_id)

    def consult(self, tab_id, prompt_text, topic, continue_url=None, stop=None):
        stop = stop or StopToken()
        sid = self._ensure_session()
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
            mc = self._js_evaluate(sid, "return JSON.stringify({count: document.querySelectorAll(" + chr(34) + "[data-message-author-role]" + chr(34) + ").length});", tab_id)
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

    def request_stop(self, stop):
        if stop:
            stop.request_stop()

    def throw_if_stop_requested(self, stop):
        if stop:
            stop.throw_if_requested()