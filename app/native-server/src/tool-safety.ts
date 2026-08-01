/**
 * Tool safety classification + preflight checks (Plan 1.2 of GO-all batch).
 *
 * Categorizes every mcp-chrome tool into one of three dependency layers based on
 * what survives an extension reload:
 *
 *   L0 (BROWSER/PROFILE):  cookies, history, bookmarks, login state, storage
 *     - always available; reload has no effect
 *   L1 (TAB IDENTITY):       tabId, windowId, URL
 *     - usually survives; tabId/windowId are Chrome-API handles, not CDP
 *   L2 (CDP RUNTIME):       targetId, sessionId, executionContextId, nodeId,
 *                            backendNodeId, listener subscription
 *     - DEAD after reload; CDP websocket + all cached bindings are gone
 *
 * Preflight strategy (cheap to expensive, applied per tool):
 *
 *   L0 tools:  skip (no dependency)
 *   L1 tools:  assertTab(tabId) - chrome.tabs.get(tabId) ~ 0 cost
 *   L2 tools:  assertRuntime() + assertTarget(targetId) - Target.getTargets() ~ 1-5ms
 *
 * @see docs/wiki/extension-reload.md for the end-to-end reload flow.
 */

export enum SafetyLevel {
  /** L0: pure browser/profile operations; safe across extension reload. */
  Safe = "safe",
  /** L1: uses tabId but not CDP target bindings; cheap preflight check. */
  TabBound = "tab-bound",
  /** L2: caches CDP runtime identity (targetId/sessionId/nodeId); reload kills these. */
  CdpBound = "cdp-bound",
}

/**
 * Classification of every chrome_* tool name. When unsure, prefer CdpBound
 * (the more conservative level — false negatives are silent corruption,
 * false positives just cost one cheap check).
 */
export const TOOL_SAFETY: Record<string, SafetyLevel> = {
  // L0 - safe across reload
  chrome_get_tab_url: SafetyLevel.Safe,
  chrome_history: SafetyLevel.Safe,
  chrome_bookmark_search: SafetyLevel.Safe,
  chrome_bookmark_add: SafetyLevel.Safe,
  chrome_bookmark_delete: SafetyLevel.Safe,
  chrome_handle_download: SafetyLevel.Safe,
  chrome_get_web_content: SafetyLevel.Safe,

  // L1 - tabId-based, cheap preflight check (assertTab)
  chrome_get_windows_and_tabs: SafetyLevel.TabBound,
  chrome_navigate: SafetyLevel.TabBound,
  chrome_screenshot: SafetyLevel.TabBound,
  chrome_switch_tab: SafetyLevel.TabBound,
  chrome_close_tabs: SafetyLevel.TabBound,
  chrome_request_element_selection: SafetyLevel.TabBound,
  chrome_read_page: SafetyLevel.TabBound,
  chrome_performance_start_trace: SafetyLevel.TabBound,
  chrome_performance_stop_trace: SafetyLevel.TabBound,
  chrome_performance_analyze_insight: SafetyLevel.TabBound,
  chrome_upload_file: SafetyLevel.TabBound,
  chrome_network_request: SafetyLevel.TabBound,
  chrome_network_capture: SafetyLevel.TabBound,
  chrome_block_images: SafetyLevel.TabBound,
  chrome_console: SafetyLevel.TabBound,
  chrome_get_page_text: SafetyLevel.TabBound,
  chrome_get_scroll_state: SafetyLevel.TabBound,
  chrome_scroll: SafetyLevel.TabBound,
  chrome_wait: SafetyLevel.TabBound,
  chrome_gif_recorder: SafetyLevel.TabBound,

  // L2 - CDP runtime dependent; require full preflight (assertRuntime + assertTarget)
  chrome_javascript: SafetyLevel.CdpBound,
  chrome_extract: SafetyLevel.CdpBound,
  chrome_click: SafetyLevel.CdpBound,
  chrome_click_and_wait: SafetyLevel.CdpBound,
  chrome_fill_or_select: SafetyLevel.CdpBound,
  chrome_computer: SafetyLevel.CdpBound,
  chrome_keyboard: SafetyLevel.CdpBound,
  chrome_hover: SafetyLevel.CdpBound,
  chrome_drag: SafetyLevel.CdpBound,
  chrome_handle_dialog: SafetyLevel.CdpBound,
  chrome_upload: SafetyLevel.CdpBound,
  chrome_web_fetcher: SafetyLevel.CdpBound,
  chrome_userscript: SafetyLevel.CdpBound,
  chrome_inject_script: SafetyLevel.CdpBound,
};

export class SessionExpiredError extends Error {
  readonly code = "SESSION_EXPIRED";
  readonly recoverable = true;
  constructor(toolName: string, reason: string) {
    super(
      `Session expired for tool "${toolName}": ${reason}. ` +
        `The Chrome extension was reloaded; re-initialize MCP session.`
    );
    this.name = "SessionExpiredError";
  }
}

export class TabGoneError extends Error {
  readonly code = "TAB_GONE";
  readonly recoverable = true;
  constructor(toolName: string, tabId: number | string | undefined) {
    super(`Tab ${tabId ?? "<unknown>"} no longer exists for tool "${toolName}".`);
    this.name = "TabGoneError";
  }
}

/**
 * Look up the safety level for a given tool name. Defaults to CdpBound
 * (most conservative) when the tool is unknown — better to over-check
 * than to silently corrupt.
 */
export function safetyLevelFor(toolName: string): SafetyLevel {
  return TOOL_SAFETY[toolName] ?? SafetyLevel.CdpBound;
}

/**
 * Cheap runtime preflight: confirm the bridge has a healthy connection to the
 * extension. The actual aliveness check is async + needs the extension
 * heartbeat map; this sync check uses the cached lastHeartbeat timestamp.
 *
 * Throws SessionExpiredError if the extension has not been heard from recently.
 */
export function assertRuntime(
  toolName: string,
  lastHeartbeatMs: number | undefined,
  nowMs: number = Date.now(),
  heartbeatStaleMs: number = 5_000
): void {
  if (lastHeartbeatMs === undefined) {
    throw new SessionExpiredError(
      toolName,
      "extension has not registered since bridge start"
    );
  }
  if (nowMs - lastHeartbeatMs > heartbeatStaleMs) {
    throw new SessionExpiredError(
      toolName,
      `last heartbeat ${Math.round((nowMs - lastHeartbeatMs) / 1000)}s ago`
    );
  }
}

/**
 * Tab-level preflight: confirm a tabId still resolves via chrome.tabs.get.
 * Caller passes the resolved tab (or undefined) so we stay sync.
 */
export function assertTab(
  toolName: string,
  tabId: number | string | undefined,
  resolvedTab: unknown | undefined
): void {
  if (resolvedTab === undefined || resolvedTab === null) {
    throw new TabGoneError(toolName, tabId);
  }
}

/**
 * CDP target-level preflight: confirm a targetId is still in the live
 * CDP targets list. Caller passes the live set; we stay sync.
 */
export function assertTarget(
  toolName: string,
  targetId: string | undefined,
  liveTargets: ReadonlySet<string> | undefined
): void {
  if (!targetId) {
    throw new SessionExpiredError(toolName, "no CDP targetId provided");
  }
  if (!liveTargets || !liveTargets.has(targetId)) {
    throw new SessionExpiredError(
      toolName,
      `CDP target ${targetId} not in live set (extension reloaded?)`
    );
  }
}
