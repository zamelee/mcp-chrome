"""chatgpt_consult.py
Reusable ChatGPT consultation via mcp-chrome bridge.
Site-specific: ONLY works on https://chatgpt.com/.
Implements AGENTS.md section 0a.7 ChatGPT ProseMirror 5-step lock.

Patch 2 (2026-07-30) additions:
  - wait_for_response: dynamic text-stable threshold (1500/2200/3000 ms)
    + Continue generating button auto-click (max 3).
  - extract_code_blocks(sid, tab_id) returns [{language, text}].
  - extract_reply returns 3-tuple (page_url, text, code_blocks).
  - save_handoff writes 4th section when code_blocks present.

Usage:
  python tools/chatgpt_consult.py <prompt.md>
  python tools/chatgpt_consult.py --continue <conv_url> <prompt.md>
  python tools/chatgpt_consult.py --capture <conv_url>
  python tools/chatgpt_consult.py ... --register
"""

import argparse, json, os, re, sys, time, urllib.request

MCP_URL = os.environ.get('MCP_URL', 'http://127.0.0.1:12306/mcp')
PROTOCOL_VERSION = '2024-11-05'
ALLOWED_HOST = 'chatgpt.com'
STATE_FILE = os.path.expanduser(r'~/.codex/ai-conversations.json')
HANDOFF_DIR = 'docs/ai-conversations'

# REPLY_SELECTOR is composed at import time from tools/selectors.json via
# compose_message_selector(). This lets us override the message container
# selector chain via ~/.codex/selectors.override.json without touching code.
try:
    from selectors import compose_message_selector
    REPLY_SELECTOR = compose_message_selector()
except ImportError:
    # Fallback when running from outside tools/ directory (e.g. tests).
    REPLY_SELECTOR = (
        chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " p, "
        + chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " pre, "
        + chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " li, "
        + chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " h1, "
        + chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " h2, "
        + chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " h3, "
        + chr(91) + "data-message-author-role=" + chr(34) + "assistant" + chr(34) + chr(93) + " h4"
    )

JS_FOCUS_CLEAR = "var ed = document.querySelector(\"#prompt-textarea\"); if (!ed) return JSON.stringify({ok:false, err:\"no editor\"}); ed.focus(); ed.innerHTML = \"<p><br class=\\\"ProseMirror-trailingBreak\\\"></p>\"; ed.dispatchEvent(new InputEvent(\"input\", {bubbles: true})); return JSON.stringify({ok:true, pCount: document.querySelectorAll(\"#prompt-textarea p\").length});"
JS_VERIFY_TEMPLATE = "var ed = document.querySelector(\"#prompt-textarea\"); if (!ed) return JSON.stringify({ok:false}); var norm = ed.innerText.replace(/[\\s\\n]+/g, \" \").trim(); function rotl(n,c){return (n<<c)|(n>>>(32-c));} var bytes=new TextEncoder().encode(norm); var len=bytes.length; var w=new Array(80); var H0=0x67452301,H1=0xEFCDAB89,H2=0x98BADCFE,H3=0x10325476,H4=0xC3D2E1F0; var padded=new Uint8Array(((len+9+63)>>6)<<6); padded.set(bytes); padded[len]=0x80; var view=new DataView(padded.buffer); view.setUint32(padded.length-4, Math.floor(len*8), false); for (var i=0; i<padded.length; i+=64) { for (var j=0; j<16; j++) w[j]=view.getUint32(i+j*4); for (var j=16; j<80; j++) w[j]=rotl(w[j-3]^w[j-8]^w[j-14]^w[j-16], 1); var a=H0,b=H1,c=H2,d=H3,e=H4; for (var j=0; j<80; j++) { var f,k; if (j<20){f=(b&c)|(~b&d);k=0x5A827999;} else if (j<40){f=b^c^d;k=0x6ED9EBA1;} else if (j<60){f=(b&c)|(b&d)|(c&d);k=0x8F1BBCDC;} else {f=b^c^d;k=0xCA62C1D6;} var t=(rotl(a,5)+f+e+k+w[j])|0; e=d;d=c;c=rotl(b,30);b=a;a=t;} H0=(H0+a)|0;H1=(H1+b)|0;H2=(H2+c)|0;H3=(H3+d)|0;H4=(H4+e)|0;} var sha=[H0,H1,H2,H3,H4].map(function(n){return (n>>>0).toString(16).padStart(8,\"0\");}).join(\"\"); var btn=document.querySelector(\"[data-testid=\\\"send-button\\\"]\") || document.querySelector(\"#composer-submit-button\"); var sendInfo= btn ? {exists:true, offsetParent: btn.offsetParent !== null, ariaDisabled: btn.getAttribute(\"aria-disabled\")} : {exists:false}; return JSON.stringify({ok:true, sha: sha, match: sha === \"__SHA__\", normLen: norm.length, pCount: document.querySelectorAll(\"#prompt-textarea p\").length, send: sendInfo});"
JS_CLICK_SEND = "var btn = document.querySelector(\"[data-testid=\\\"send-button\\\"]\") || document.querySelector(\"#composer-submit-button\"); if (!btn) return JSON.stringify({ok:false, err:\"no send btn\"}); var r = btn.getBoundingClientRect(); return JSON.stringify({ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});"
JS_WAIT_SNAPSHOT = "var nodes = document.querySelectorAll(\"[data-message-author-role]\"); var last = nodes[nodes.length - 1]; var lastRole = last ? last.getAttribute(\"data-message-author-role\") : null; var stopBtn = document.querySelector(\"button[aria-label=\\\"Stop generating\\\"], button[aria-label=\\\"stop generating\\\"]\"); var contBtn = null; var allBtns = document.querySelectorAll(\"button\"); for (var i=0;i<allBtns.length;i++){var t=(allBtns[i].innerText||\"\").trim(); if(t.indexOf(\"Continue generating\")>=0){contBtn=allBtns[i];break;}} var regenBtn = null; for (var i2=0;i2<allBtns.length;i2++){var t2=(allBtns[i2].innerText||\"\").trim(); if(t2.indexOf(\"Regenerate\")>=0 && t2.indexOf(\"Continue\")<0){regenBtn=allBtns[i2];break;}} var sendEnabled = !!document.querySelector(\"#prompt-textarea\"); var txt=\"\"; if (last && lastRole===\"assistant\") { txt = last.innerText || \"\"; } return JSON.stringify({count: nodes.length, stop: !!stopBtn, sendEnabled: sendEnabled, hasContinue: !!contBtn, hasRegenerate: !!regenBtn, lastRole: lastRole, txt: txt});"
JS_CONTINUE_PROBE = "var allBtns = document.querySelectorAll(\"button\"); var contBtn = null; for (var i=0;i<allBtns.length;i++){var t=(allBtns[i].innerText||\"\").trim(); if(t.indexOf(\"Continue generating\")>=0){contBtn=allBtns[i];break;}} if (!contBtn) return JSON.stringify({ok:false, err:\"no continue btn\"}); var r = contBtn.getBoundingClientRect(); return JSON.stringify({ok:true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)});"
JS_EXTRACT_CODE_BLOCKS = "var nodes = document.querySelectorAll(\"[data-message-author-role=assistant]\"); var last = nodes[nodes.length - 1]; if (!last) return JSON.stringify([]); var pres = last.querySelectorAll(\"pre\"); var out = []; for (var i=0;i<pres.length;i++){ var pre = pres[i]; var codeEl = pre.querySelector(\"code\"); var lang = \"\"; if (codeEl) { var cls = codeEl.className || \"\"; var m = cls.match(/language-([a-zA-Z0-9_+-]+)/); if (m) lang = m[1]; if (!lang) { var dm = codeEl.getAttribute(\"data-language\"); if (dm) lang = dm; } } if (!lang) lang = \"text\"; var text = codeEl ? (codeEl.innerText || codeEl.textContent || \"\") : (pre.innerText || pre.textContent || \"\"); out.push({language: lang, text: text}); } return JSON.stringify(out);"
JS_WAIT_FOR_LOAD = "return JSON.stringify({ready: document.readyState, url: location.href, msgCount: document.querySelectorAll(\"[data-message-author-role]\").length, hasEditor: !!document.querySelector(\"#prompt-textarea\")});"
JS_MSG_COUNT = "return JSON.stringify({count: document.querySelectorAll(\"[data-message-author-role]\").length});"
def post(payload, headers=None):
    h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
    if headers: h.update(headers)
    req = urllib.request.Request(MCP_URL, data=json.dumps(payload).encode(), headers=h)
    resp = urllib.request.urlopen(req, timeout=30)
    sid = resp.headers.get('Mcp-Session-Id') or resp.headers.get('mcp-session-id')
    return sid, resp.read().decode()
def parse_sse(body):
    for line in body.splitlines():
        if line.startswith('data: '): return line[len('data: '):]
    return body
def ensure_session():
    sid, body = post({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': PROTOCOL_VERSION, 'capabilities': {}, 'clientInfo': {'name': 'chatgpt-consult', 'version': '1.0'}}})
    if not sid:
        print('init failed:', body[:300], file=sys.stderr); sys.exit(1)
    return sid
def js_evaluate(sid, code, tab_id, retries=2):
    last_err = None
    for _ in range(retries):
        try:
            _, body = post({'jsonrpc': '2.0', 'id': 99, 'method': 'tools/call', 'params': {'name': 'chrome_javascript', 'arguments': {'tabId': tab_id, 'code': code}}}, headers={'Mcp-Session-Id': sid})
            pkt = json.loads(parse_sse(body))
            inner_text = pkt['result']['content'][0]['text']
            inner = json.loads(inner_text)
            return json.loads(inner['result'])
        except Exception as e:
            last_err = str(e)
            time.sleep(0.5)
    return {'error': last_err or 'unknown', 'code_snippet': code[:80]}
def chrome_navigate(sid, url, tab_id):
    _, body = post({'jsonrpc': '2.0', 'id': 96, 'method': 'tools/call', 'params': {'name': 'chrome_navigate', 'arguments': {'url': url, 'tabId': tab_id}}}, headers={'Mcp-Session-Id': sid})
    return json.loads(parse_sse(body))
def chrome_computer(sid, action, tab_id, **kwargs):
    args = {'action': action}; args.update(kwargs); args['tabId'] = tab_id
    _, body = post({'jsonrpc': '2.0', 'id': 97, 'method': 'tools/call', 'params': {'name': 'chrome_computer', 'arguments': args}}, headers={'Mcp-Session-Id': sid})
    pkt = json.loads(parse_sse(body))
    inner_text = pkt['result']['content'][0]['text']
    return json.loads(inner_text) if inner_text.startswith('{') else pkt
def chrome_extract(sid, tab_id, selector, fields):
    _, body = post({'jsonrpc': '2.0', 'id': 95, 'method': 'tools/call', 'params': {'name': 'chrome_extract', 'arguments': {'tabId': tab_id, 'selector': selector, 'fields': fields}}}, headers={'Mcp-Session-Id': sid})
    pkt = json.loads(parse_sse(body))
    return json.loads(pkt['result']['content'][0]['text'])
def guard_site(sid, tab_id):
    info = js_evaluate(sid, "return JSON.stringify({host: location.host, url: location.href});", tab_id)
    if "error" in info:
        print("site probe failed:", info.get("error", "unknown"), file=sys.stderr); sys.exit(2)
    host = info.get("host", "")
    if ALLOWED_HOST not in host:
        print(f"ERROR: this script only works on {ALLOWED_HOST}; current host is {host}", file=sys.stderr); sys.exit(2)
def focus_and_clear(sid, tab_id, retries=8):
    last = {}
    for _ in range(retries):
        last = js_evaluate(sid, JS_FOCUS_CLEAR, tab_id)
        if last.get("ok"):
            return last
        time.sleep(0.8)
    return last
def type_prompt(sid, tab_id, text):
    return chrome_computer(sid, "type", tab_id, text=text)
def verify_injection(sid, tab_id, expected_sha):
    JS = JS_VERIFY_TEMPLATE.replace('__SHA__', expected_sha)
    return js_evaluate(sid, JS, tab_id)
def click_send(sid, tab_id):
    info = js_evaluate(sid, JS_CLICK_SEND, tab_id)
    if not info.get("ok"):
        return False, info
    return True, chrome_computer(sid, "left_click", tab_id, coordinates={"x": info["x"], "y": info["y"]})
def dynamic_stable_ms(txt_len):
    if txt_len > 8000:
        return 3000
    if txt_len > 2000:
        return 2200
    return 1500
def click_continue_button(sid, tab_id):
    info = js_evaluate(sid, JS_CONTINUE_PROBE, tab_id)
    if not info.get("ok"):
        return False
    chrome_computer(sid, "left_click", tab_id, coordinates={"x": info["x"], "y": info["y"]})
    return True
def wait_for_response(sid, tab_id, prev_count, timeout_s=180):
    t0 = time.time()
    last = {}
    stable_ms_required = 1500
    stable_since = None
    continue_clicks = 0
    stop_gone_since = None
    while time.time() - t0 < timeout_s:
        last = js_evaluate(sid, JS_WAIT_SNAPSHOT, tab_id)
        count = last.get("count", 0)
        stop = last.get("stop")
        has_continue = last.get("hasContinue")
        send_enabled = last.get("sendEnabled")
        txt = last.get("txt") or ""
        dynamic_ms = dynamic_stable_ms(len(txt))
        if stable_ms_required != dynamic_ms:
            stable_ms_required = dynamic_ms
            stable_since = None
        if has_continue and continue_clicks < 3 and not stop:
            if click_continue_button(sid, tab_id):
                continue_clicks += 1
                time.sleep(0.4)
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
        time.sleep(0.4)
    return False, last
def extract_code_blocks(sid, tab_id):
    raw = js_evaluate(sid, JS_EXTRACT_CODE_BLOCKS, tab_id)
    if isinstance(raw, dict) and "error" in raw:
        return []
    if isinstance(raw, list):
        return raw
    return []
def extract_reply(sid, tab_id):
    inner = chrome_extract(sid, tab_id, selector=REPLY_SELECTOR, fields=[{"name": "text", "selector": "", "type": "text"}])
    seen = set()
    parts_acc = []
    for it in inner.get("items", []):
        t = (it.get("text") or "").strip()
        if t and t not in seen:
            seen.add(t)
            parts_acc.append(t)
    text = "\n\n".join(parts_acc)
    code_blocks = extract_code_blocks(sid, tab_id)
    return inner.get("pageUrl", "unknown"), text, code_blocks
def register_conversation(project, url, topic, notes=""):
    if not os.path.exists(STATE_FILE):
        print(STATE_FILE, 'not found', file=sys.stderr); return False
    with open(STATE_FILE, encoding='utf-8') as f: d = json.load(f)
    convs = d.get("conversations", []) if isinstance(d, dict) else d
    convs.append({'project': project, 'platform': 'chatgpt', 'url': url, 'topic': topic, 'lastUpdated': time.strftime('%Y-%m-%d'), 'incident': None, 'notes': notes})
    if isinstance(d, dict): d["conversations"] = convs
    else: d = {"conversations": convs, "_system_incidents": []}
    with open(STATE_FILE, 'w', encoding='utf-8') as f: json.dump(d, f, indent=2, ensure_ascii=False)
    return True
def save_handoff(topic, url, prompt_text, response_text, code_blocks=None):
    os.makedirs(HANDOFF_DIR, exist_ok=True)
    date = time.strftime('%Y-%m-%d')
    safe = re.sub(r'[^a-zA-Z0-9-]+', '-', topic.lower())[:60].strip('-')
    out = os.path.join(HANDOFF_DIR, f'{date}-{safe}.md')
    with open(out, 'w', encoding='utf-8') as f:
        header = (
            f"# {topic}"
            + chr(10) + chr(10)
            + f"- Date: {date}"
            + chr(10) + "- Platform: chatgpt.com"
            + chr(10) + f"- URL: {url}"
            + chr(10) + f"- Conversation ID: {url.rsplit(chr(47), 1)[-1]}"
            + chr(10) + f"- Response length: {len(response_text)} chars"
            + chr(10) + chr(10) + "---"
            + chr(10) + chr(10) + "## Prompt (verbatim)"
            + chr(10) + chr(10)
        )
        f.write(header)
        f.write(prompt_text)
        reply_divider = (
            chr(10) + chr(10) + "---"
            + chr(10) + chr(10) + "## ChatGPT reply (verbatim)"
            + chr(10) + chr(10)
        )
        f.write(reply_divider)
        f.write(response_text)
        f.write(chr(10))
        if code_blocks:
            cb_intro = (
                chr(10) + chr(10) + "---"
                + chr(10) + chr(10) + "## Code blocks (separated)"
                + chr(10) + chr(10)
            )
            f.write(cb_intro)
            f.write(f"- Code blocks extracted: {len(code_blocks)}" + chr(10) + chr(10))
            for idx, blk in enumerate(code_blocks, start=1):
                lang = blk.get("language", "text")
                text_b = blk.get("text", "")
                heading = "### Block " + str(idx) + " (" + lang + ")" + chr(10) + chr(10)
                fence = chr(96) + chr(96) + chr(96) + lang + chr(10)
                closer = chr(10) + chr(96) + chr(96) + chr(96) + chr(10)
                f.write(heading)
                f.write(fence)
                f.write(text_b)
                f.write(closer)
    return out


def wait_for_load(sid, tab_id, target_msg_count=1, timeout_s=60):
    time.sleep(3)
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout_s:
        last = js_evaluate(sid, JS_WAIT_FOR_LOAD, tab_id)
        if last.get("ready") == "complete" and last.get("hasEditor") and last.get("msgCount", 0) >= target_msg_count:
            return True, last
        time.sleep(2)
    return False, last

def consult(prompt_path, tab_id, register=False, topic=None, continue_url=None, bundle_name=None, cli_prompt_prefix="", cli_attachments=None, cli_context_paths=None):
    prompt_text = open(prompt_path, encoding='utf-8').read().strip()
    # Patch 5: --bundle NAME merges bundle context with CLI args before sha1.
    if bundle_name:
        try:
            import bundles as _bundles_mod
        except ImportError:
            print('FATAL: --bundle requires tools/bundles.py on sys.path (run from project root)', file=sys.stderr); sys.exit(8)
        try:
            bundle = _bundles_mod.load_bundle(bundle_name)
        except _bundles_mod.BundleNotFoundError as e:
            print('FATAL: bundle ' + repr(e.name) + ' not found in ' + e.searched_dir + ' (exit code 8 matches HTTP 404)', file=sys.stderr); sys.exit(8)
        merged = _bundles_mod.merge_bundle_with_args(bundle, prompt_text=prompt_text, attachments=cli_attachments, context_paths=cli_context_paths, prompt_prefix=cli_prompt_prefix)
        bname = bundle.get('name', '?')
        log('bundle: ' + repr(bname) + ' merged (attachments=' + str(len(merged['attachments'])) + ', contextPaths=' + str(len(merged['contextPaths'])) + ')')
        prompt_text = merged['prompt']
    if not topic: topic = os.path.basename(prompt_path).rsplit(".", 1)[0][:60]
    expected_norm = re.sub(r"[\s\n]+", " ", prompt_text).strip()
    import hashlib
    expected_sha = hashlib.sha1(expected_norm.encode("utf-8")).hexdigest()
    def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}")
    log(f"prompt: {len(prompt_text)} chars, expected sha1 prefix: {expected_sha[:8]}...")
    sid = ensure_session()
    guard_site(sid, tab_id)
    log("site guard passed")
    if continue_url:
        log(f"navigating to: {continue_url}")
        chrome_navigate(sid, continue_url, tab_id)
        ok, info = wait_for_load(sid, tab_id, target_msg_count=1, timeout_s=60)
        if not ok:
            print('FATAL: continue_url did not load: ' + str(info), file=sys.stderr); sys.exit(7)
    cleared = focus_and_clear(sid, tab_id)
    log("editor cleared: " + str(cleared.get("pCount", 0)) + " <p> remaining")
    log("typing prompt via CDP Input.insertText...")
    type_prompt(sid, tab_id, prompt_text)
    time.sleep(0.8)
    log("verifying sha1 + send button state...")
    verified = verify_injection(sid, tab_id, expected_sha)
    if not verified.get("match"):
        print('FATAL: sha1 mismatch. expected ' + expected_sha + ' got ' + str(verified.get('sha')), file=sys.stderr); sys.exit(3)
    s = verified.get("send", {})
    if not (s.get("exists") and s.get("offsetParent") and s.get("ariaDisabled") != "true"):
        print('FATAL: send button bad: ' + str(s), file=sys.stderr); sys.exit(4)
    log("sha1 + send button good, clicking...")
    ok, click_info = click_send(sid, tab_id)
    if not ok: print('FATAL: click failed: ' + str(click_info), file=sys.stderr); sys.exit(5)
    pre = js_evaluate(sid, JS_MSG_COUNT, tab_id)
    pre_count = pre.get("count", 0)
    log(f"send clicked (msgCount was {pre_count}). waiting for response...")
    ok, info = wait_for_response(sid, tab_id, pre_count)
    if not ok: print('FATAL: timeout. last state: ' + str(info), file=sys.stderr); sys.exit(6)
    log(f"response complete. msgCount now {info.get("count", 0)}")
    url, text, code_blocks = extract_reply(sid, tab_id)
    log(f"URL: {url}")
    log(f"reply: {len(text)} chars; {len(code_blocks)} code blocks")
    handoff_path = save_handoff(topic, url, prompt_text, text, code_blocks=code_blocks)
    log(f"handoff: {handoff_path}")
    if register:
        ok = register_conversation('mcp-chrome', url, topic, notes=f"Captured by tools/chatgpt_consult.py on {time.strftime('%Y-%m-%d')}")
        log("ai-conversations.json: " + ("ok" if ok else "skipped"))
    log(f"done. URL: {url}")
    return url, text, handoff_path

def capture_only(url, tab_id, topic=None):
    sid = ensure_session()
    chrome_navigate(sid, url, tab_id)
    ok, info = wait_for_load(sid, tab_id, target_msg_count=1, timeout_s=60)
    if not ok: print('page did not load: ' + str(info), file=sys.stderr); sys.exit(6)
    url2, text, code_blocks = extract_reply(sid, tab_id)
    if not topic: topic = f"chatgpt-{url2.rsplit(chr(47), 1)[-1][:8]}"
    handoff_path = save_handoff(topic, url2, "(captured from existing URL; original prompt not preserved)", text, code_blocks=code_blocks)
    print(f"captured: {len(text)} chars -> {handoff_path}")
    return url2, text, handoff_path

def main():
    p = argparse.ArgumentParser(description='ChatGPT consultation via mcp-chrome bridge')
    p.add_argument('prompt', nargs='?', help='Path to prompt markdown/text file')
    p.add_argument('--capture', help='Extract existing reply from chatgpt.com URL without sending')
    p.add_argument('--continue', dest='continue_url', help='Continue an existing chatgpt.com conversation')
    p.add_argument('--topic', help='Topic for handoff doc (defaults to filename)')
    p.add_argument('--register', action='store_true', help='Also register in ~/.codex/ai-conversations.json')
    p.add_argument("--tab-id", type=int, default=1327679416, help="Chrome tab id")
    p.add_argument("--bundle", help="Bundle name to load from prompts/bundles/{NAME}.json (Patch 5)")
    p.add_argument("--prompt-prefix", default="", help="Additional prompt prefix appended after bundle prefix")
    p.add_argument("--attachment", action="append", default=[], help="Additional file attachment (can be repeated)")
    p.add_argument("--context-path", action="append", default=[], help="Additional context directory (can be repeated)")
    p.add_argument("--use-controller", action="store_true", help="(Step 1 integration test) Use the new ChatGPTController subclass (Patch 6 base class). Default: use the legacy inline flow.")
    args = p.parse_args()
    if args.capture: capture_only(args.capture, tab_id=args.tab_id, topic=args.topic)
    elif args.prompt:
        if args.use_controller:
            # Step 1 integration: delegate to ChatGPTController (Patch 6 subclass).
            # Exercises VendorControllerBase.consult() + bundle merge (Patch 5) + selectors.json (Patch 4) + waitForAssistantStable (Patch 2).
            from chatgpt_controller import ChatGPTController
            prompt_text = open(args.prompt, encoding="utf-8").read().strip()
            if args.bundle:
                try:
                    import bundles as _bundles_mod
                    bundle = _bundles_mod.load_bundle(args.bundle)
                    merged = _bundles_mod.merge_bundle_with_args(bundle, prompt_text=prompt_text, attachments=args.attachment, context_paths=args.context_path, prompt_prefix=args.prompt_prefix)
                    prompt_text = merged["prompt"]
                except _bundles_mod.BundleNotFoundError as e:
                    print("FATAL: bundle " + repr(e.name) + " not found in " + e.searched_dir + " (exit code 8)", file=sys.stderr); sys.exit(8)
            if not args.topic:
                topic = os.path.basename(args.prompt).rsplit(".", 1)[0][:60]
            else:
                topic = args.topic
            ctl = ChatGPTController()
            url, text, handoff_path = ctl.consult(tab_id=args.tab_id, prompt_text=prompt_text, topic=topic, continue_url=args.continue_url)
            if args.register:
                register_conversation("mcp-chrome", url, topic, notes="Captured by tools/chatgpt_consult.py --use-controller on " + time.strftime("%Y-%m-%d"))
            print("done. URL: " + url)
            print("handoff: " + handoff_path)
        else:
            consult(args.prompt, tab_id=args.tab_id, topic=args.topic, register=args.register, continue_url=args.continue_url, bundle_name=args.bundle, cli_prompt_prefix=args.prompt_prefix, cli_attachments=args.attachment, cli_context_paths=args.context_path)
    else: p.print_help(); sys.exit(1)

if __name__ == '__main__':
    main()

