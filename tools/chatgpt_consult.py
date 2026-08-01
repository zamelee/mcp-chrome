"""chatgpt_consult.py

CLI wrapper around ChatGPTController (Patch 6 base class).

All vendor-specific logic (ProseMirror composer, Continue generating
auto-click, dynamic stable threshold, sha1 injection verify) lives in
tools/chatgpt_controller.py which extends VendorControllerBase from
tools/vendor_base.py. This script is the CLI surface only:

  - argparse
  - bundle loading + merge (Patch 5)
  - ai-conversations.json append (--register)
  - delegate to ChatGPTController.consult() / .capture()

Usage:
  python tools/chatgpt_consult.py <prompt.md>
  python tools/chatgpt_consult.py --bundle repo-review <prompt.md>
  python tools/chatgpt_consult.py --capture https://chatgpt.com/c/abc
  python tools/chatgpt_consult.py --continue https://chatgpt.com/c/abc <prompt.md>
"""
import argparse, json, os, sys, time

STATE_FILE = os.path.expanduser(r"~/.codex/ai-conversations.json")
DEFAULT_TAB_ID = 1327679416


def register_conversation(project, url, topic, notes=""):
    """Append a conversation entry to ~/.codex/ai-conversations.json.

    Returns True on success, False if the file is missing or malformed.
    Schema follows AGENTS.md section 0c.1 (no incident).
    """
    if not os.path.exists(STATE_FILE):
        return False
    with open(STATE_FILE, encoding="utf-8") as f:
        d = json.load(f)
    convs = d.get("conversations", []) if isinstance(d, dict) else d
    convs.append({
        "project": project,
        "platform": "chatgpt",
        "url": url,
        "topic": topic,
        "lastUpdated": time.strftime("%Y-%m-%d"),
        "incident": None,
        "notes": notes,
    })
    if isinstance(d, dict):
        d["conversations"] = convs
    else:
        d = {"conversations": convs, "_system_incidents": []}
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    return True


def _apply_bundle_merge(args, prompt_text):
    """Load + merge a bundle if --bundle is given. Returns the final prompt text.

    Raises SystemExit(8) if the bundle is not found (matches HTTP 404).
    """
    if not args.bundle:
        return prompt_text
    import bundles as _bundles
    try:
        bundle = _bundles.load_bundle(args.bundle)
    except _bundles.BundleNotFoundError as e:
        print("FATAL: bundle " + repr(e.name) + " not found in " + e.searched_dir + " (exit code 8 matches HTTP 404)", file=sys.stderr)
        sys.exit(8)
    merged = _bundles.merge_bundle_with_args(
        bundle,
        prompt_text=prompt_text,
        attachments=args.attachment,
        context_paths=args.context_path,
        prompt_prefix=args.prompt_prefix,
    )
    return merged["prompt"]


def consult(args):
    """Main consultation path: load prompt, apply bundle, delegate to ChatGPTController."""
    from chatgpt_controller import ChatGPTController

    prompt_text = open(args.prompt, encoding="utf-8").read().strip()
    prompt_text = _apply_bundle_merge(args, prompt_text)

    if not args.topic:
        topic = os.path.basename(args.prompt).rsplit(".", 1)[0][:60]
    else:
        topic = args.topic

    ctl = ChatGPTController()
    url, text, handoff = ctl.consult(
        tab_id=args.tab_id,
        prompt_text=prompt_text,
        topic=topic,
        continue_url=args.continue_url,
    )
    if args.register:
        register_conversation(
            "mcp-chrome", url, topic,
            notes="Captured by tools/chatgpt_consult.py on " + time.strftime("%Y-%m-%d"),
        )
    print("done. URL: " + url)
    print("reply: " + str(len(text)) + " chars")
    print("handoff: " + handoff)


def capture(args):
    """Read-only path: load an existing chatgpt.com conversation and save its reply."""
    from chatgpt_controller import ChatGPTController

    ctl = ChatGPTController()
    url, text, handoff = ctl.capture(
        url=args.capture,
        tab_id=args.tab_id,
        topic=args.topic,
    )
    if args.register:
        register_conversation(
            "mcp-chrome", url,
            args.topic if args.topic else ("chatgpt-" + url.rsplit(chr(47), 1)[-1][:8]),
            notes="Captured by tools/chatgpt_consult.py --capture on " + time.strftime("%Y-%m-%d"),
        )
    print("captured: " + str(len(text)) + " chars -> " + handoff)


def main():
    p = argparse.ArgumentParser(description="ChatGPT consultation via mcp-chrome bridge (Patch 6 base class)")
    p.add_argument("prompt", nargs="?", help="Path to prompt markdown/text file")
    p.add_argument("--capture", help="Extract existing reply from chatgpt.com URL without sending")
    p.add_argument("--continue", dest="continue_url", help="Continue an existing chatgpt.com conversation")
    p.add_argument("--topic", help="Topic for handoff doc (defaults to filename)")
    p.add_argument("--register", action="store_true", help="Also register in ~/.codex/ai-conversations.json")
    p.add_argument("--tab-id", type=int, default=DEFAULT_TAB_ID, help="Chrome tab id")
    p.add_argument("--bundle", help="Bundle name to load from prompts/bundles/{NAME}.json (Patch 5)")
    p.add_argument("--prompt-prefix", default="", help="Additional prompt prefix appended after bundle prefix")
    p.add_argument("--attachment", action="append", default=[], help="Additional file attachment (can be repeated)")
    p.add_argument("--context-path", action="append", default=[], help="Additional context directory (can be repeated)")
    args = p.parse_args()

    if args.capture:
        capture(args)
    elif args.prompt:
        consult(args)
    else:
        p.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
