import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import nativeMessagingHostInstance from '../native-messaging-host';
import { NativeMessageType, TOOL_SCHEMAS } from '@ethanwilkins/chrome-mcp-shared-2026';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { SessionExpiredError, TabGoneError, safetyLevelFor, SafetyLevel } from '../tool-safety';
import { getLatestExtensionConnection } from '../control-state';
import { HEARTBEAT_STALE_MS } from '../constant';
import { buildSessionMeta, type McpSessionMeta } from './session-meta';
import { getReloadContext } from './reload-context';

interface ToolActivity {
  requestId: string;
  name: string;
  tabId?: number;
  startedAt: string;
  queueMs?: number;
  executionStartedAt?: string;
  elapsedMs?: number;
  outcome: 'running' | 'success' | 'error' | 'cancelled';
  error?: string;
}
const recentToolCalls: ToolActivity[] = [];
export const getRecentToolCalls = (): ToolActivity[] => recentToolCalls.slice(-20).reverse();
const WRITE_TOOL = /(?:navigate|click|scroll|fill|keyboard|key|dialog|computer|upload)/;
const LONG_TOOL = /(?:performance|trace|record|download|upload)/;
const NAVIGATION_TOOL = /(?:navigate|download|upload)/;
const tabQueues = new Map<string, Promise<void>>();
const MIN_TOOL_TRANSPORT_TIMEOUT_MS = 20_000;

async function listDynamicFlowTools(): Promise<Tool[]> {
  try {
    const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
      {},
      'rr_list_published_flows',
      20000,
    );
    if (response && response.status === 'success' && Array.isArray(response.items)) {
      const tools: Tool[] = [];
      for (const item of response.items) {
        const name = `flow.${item.slug}`;
        const description =
          (item.meta && item.meta.tool && item.meta.tool.description) ||
          item.description ||
          'Recorded flow';
        const properties: Record<string, any> = {};
        const required: string[] = [];
        for (const v of item.variables || []) {
          const desc = v.label || v.key;
          const typ = (v.type || 'string').toLowerCase();
          const prop: any = { description: desc };
          if (typ === 'boolean') prop.type = 'boolean';
          else if (typ === 'number') prop.type = 'number';
          else if (typ === 'enum') {
            prop.type = 'string';
            if (v.rules && Array.isArray(v.rules.enum)) prop.enum = v.rules.enum;
          } else if (typ === 'array') {
            // default array of strings; can extend with itemType later
            prop.type = 'array';
            prop.items = { type: 'string' };
          } else {
            prop.type = 'string';
          }
          if (v.default !== undefined) prop.default = v.default;
          if (v.rules && v.rules.required) required.push(v.key);
          properties[v.key] = prop;
        }
        // Run options
        properties['tabTarget'] = { type: 'string', enum: ['current', 'new'], default: 'current' };
        properties['refresh'] = { type: 'boolean', default: false };
        properties['captureNetwork'] = { type: 'boolean', default: false };
        properties['returnLogs'] = { type: 'boolean', default: false };
        properties['timeoutMs'] = { type: 'number', minimum: 0 };
        const tool: Tool = {
          name,
          description,
          inputSchema: { type: 'object', properties, required },
        };
        tools.push(tool);
      }
      return tools;
    }
    return [];
  } catch (e) {
    return [];
  }
}

export const setupTools = (server: Server) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const dynamicTools = await listDynamicFlowTools();
    return { tools: [...TOOL_SCHEMAS, ...dynamicTools] };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    handleToolCall(request.params.name, request.params.arguments || {}, extra.signal),
  );
};

function timeoutFor(name: string, args: any): number {
  const ceiling = LONG_TOOL.test(name) ? 120_000 : NAVIGATION_TOOL.test(name) ? 60_000 : 20_000;
  const requested = Number(args.timeoutMs ?? args.timeout);
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, MIN_TOOL_TRANSPORT_TIMEOUT_MS), ceiling)
    : ceiling;
}

function serialByTab<T>(
  name: string,
  args: any,
  task: () => Promise<T>,
  onStart?: () => void,
): Promise<T> {
  if (args.newWindow || (!WRITE_TOOL.test(name) && !name.startsWith('flow.'))) {
    onStart?.();
    return task();
  }
  const key = `tab:${typeof args.tabId === 'number' ? args.tabId : 'active'}`;
  const previous = tabQueues.get(key) || Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(() => {
      onStart?.();
      return task();
    });
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tabQueues.set(key, tail);
  void tail.finally(() => {
    if (tabQueues.get(key) === tail) tabQueues.delete(key);
  });
  return result;
}

async function resolveWriteTab(args: any, signal?: AbortSignal): Promise<any> {
  if (typeof args.tabId === 'number' || args.newWindow) return args;
  const response = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
    { name: 'chrome_get_tab_url', args: { windowId: args.windowId } },
    NativeMessageType.CALL_TOOL,
    5_000,
    signal,
  );
  const text = response?.data?.content?.[0]?.text;
  const tabId = typeof text === 'string' ? JSON.parse(text).tabId : undefined;
  if (typeof tabId !== 'number') throw new Error('Could not resolve the active tab before write');
  return { ...args, tabId };
}

/**
 * Plan 1.4: tool preflight. Cheap sync checks before we spend a round-trip
 * to the extension. Returns a CallToolResult-with-isError if the call should
 * be refused, or null if the call may proceed.
 *
 * Exported with an `@internal` tag for unit testing only; production code
 * always goes through handleToolCall -> runPreflight.
 *
 * Decision tree (matches TOOL_SAFETY in tool-safety.ts):
 *   Safe       → no preflight (pure browser/profile; reload does not affect)
 *   TabBound   → assertRuntime; cheap tab probe is async + lives in the
 *                extension, so defer it to the native-messaging hop (its
 *                error already surfaces as `tab gone` naturally)
 *   CdpBound   → assertRuntime + assertTarget if args.targetId provided
 *
 * All preflight failures are surfaced as MCP semantic errors
 * ({code: "SESSION_EXPIRED" | "TAB_GONE"}) so newer clients can switch on
 * `code` and skip retries; older clients still see a useful message string.
 *
 * v1.8+ soft-degradation protocol (RFC docs/rfcs/2026-08-02-mcp-session-soft-degradation.md):
 *   - NORMAL              → continue (liveTargets check below)
 *   - STALE_RECOVERED     → return { degraded: true, meta }, caller attaches _meta
 *   - EXTENSION_STARTING  → return error with retryAfterMs (retryable)
 *   - SESSION_NOT_FOUND   → return error (conn never registered, hard fail)
 *
 * Legacy SESSION_EXPIRED is preserved for "tab/target not in live set" (client error,
 * not session lifecycle). v1.7.4-era SESSION_EXPIRED for "heartbeat stale" is
 * replaced by STALE_RECOVERED + EXTENSION_STARTING per the four-state judgment.
 */
/**
 * @internal exported solely so unit tests can drive the decision tree without
 * spinning up a full MCP server. Production code reaches it indirectly via
 * handleToolCall.
 */
export type PreflightResult =
  | { isError: true; content: Array<{ type: 'text'; text: string }> }
  | { degraded: true; meta: McpSessionMeta }
  | null;

export function runPreflight(name: string, args: any): PreflightResult {
  const conn = getLatestExtensionConnection();
  const level = safetyLevelFor(name);

  // Safe tools do not depend on extension state at all.
  if (level === SafetyLevel.Safe) return null;

  // TabBound + CdpBound both need a live extension heartbeat.
  if (!conn) {
    // v1.8+: SESSION_NOT_FOUND replaces SESSION_EXPIRED for "never registered".
    return errorResult(
      name,
      'SESSION_NOT_FOUND',
      'extension has not registered since bridge start',
    );
  }
  // 90s = 1.5x HEARTBEAT_INTERVAL_MS (60s). Must stay > heartbeat interval so
  // the preflight does not fire between heartbeats (previous 5s threshold
  // rejected ~92% of every minute; see constant/HEARTBEAT_STALE_MS).
  if (Date.now() - conn.lastHeartbeat > HEARTBEAT_STALE_MS) {
    // v1.8+ four-state judgment via session-meta.ts (Phase 1a).
    const meta = buildSessionMeta(conn, getReloadContext());

    if (meta.sessionStatus === 'extension_starting') {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: 'EXTENSION_STARTING',
              recoverable: true,
              toolName: name,
              retryAfterMs: meta.retryAfterMs,
              heartbeatGapMs: meta.heartbeatGapMs,
              reloadGapMs: meta.reloadGapMs,
              message:
                `Extension reloading (last heartbeat ${Math.round((meta.heartbeatGapMs ?? 0) / 1000)}s ago). ` +
                `Retry after ${meta.retryAfterMs}ms.`,
            }),
          },
        ],
      };
    }

    if (meta.sessionStatus === 'stale_recovered') {
      return { degraded: true, meta };
    }

    // Defensive fallback (should not be reachable per buildSessionMeta contract).
    return errorResult(
      name,
      'SESSION_EXPIRED',
      `last heartbeat ${Math.round((Date.now() - conn.lastHeartbeat) / 1000)}s ago`,
    );
  }

  // CdpBound additionally checks the live target set when the tool passes a targetId.
  // We also accept tabId (number) because the extension's heartbeat emits tab IDs
  // (from chrome.tabs.query) as the liveTargets payload. CDP targetId semantics
  // are stricter (L2), tabId is L1 — but a stale tabId is the most common
  // reload signal we get, so we check both shapes.
  if (level === SafetyLevel.CdpBound) {
    const targetId = typeof args?.targetId === 'string' ? args.targetId : undefined;
    const tabId =
      typeof args?.tabId === 'number'
        ? String(args.tabId)
        : typeof args?.tabId === 'string'
          ? args.tabId
          : undefined;
    if (targetId && !conn.liveTargets.has(targetId)) {
      return errorResult(
        name,
        'SESSION_EXPIRED',
        `CDP target ${targetId} not in live set (extension reloaded?)`,
      );
    }
    if (tabId && !conn.liveTargets.has(tabId)) {
      return errorResult(
        name,
        'SESSION_EXPIRED',
        `Tab ${tabId} not in live set (extension reloaded?)`,
      );
    }
  }

  // TabBound also checks tab presence when the tool passes a tabId.
  // (Plan 2.3 update: extension heartbeat emits tab IDs; preflight now checks
  // tab presence for TabBound tools too — without it a stale tabId would
  // round-trip to the dead extension before being rejected downstream.)
  if (level === SafetyLevel.TabBound) {
    const tabId =
      typeof args?.tabId === 'number'
        ? String(args.tabId)
        : typeof args?.tabId === 'string'
          ? args.tabId
          : undefined;
    if (tabId && !conn.liveTargets.has(tabId)) {
      return errorResult(
        name,
        'SESSION_EXPIRED',
        `Tab ${tabId} not in live set (extension reloaded?)`,
      );
    }
  }

  return null;
}

function errorResult(
  toolName: string,
  code: 'SESSION_NOT_FOUND' | 'EXTENSION_STARTING' | 'SESSION_EXPIRED' | 'TAB_GONE',
  message: string,
): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  const payload = {
    code,
    recoverable: true,
    toolName,
    message:
      `Session expired for tool "${toolName}": ${message}. ` +
      `The Chrome extension was reloaded; re-initialize MCP session.`,
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

/**
 * Attach a v1.8+ soft-degradation _meta to a successful tool result.
 *
 * - If `meta` is null (NORMAL preflight), returns the result unchanged.
 * - If `meta` is present (STALE_RECOVERED preflight), merges it into
 *   `result._meta`. Per MCP spec, `_meta` is an open-ended object on
 *   CallToolResult, so we don't clobber any existing fields.
 *
 * Pure helper; no module state.
 */
function attachDegradedMeta(result: CallToolResult, meta: McpSessionMeta | null): CallToolResult {
  if (!meta) return result;
  return {
    ...result,
    _meta: { ...(result as any)._meta, ...meta },
  };
}

const handleToolCall = async (
  name: string,
  args: any,
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  // Plan 1.4: preflight - refuse the call with a structured error if the
  // extension has not been heard from recently (or hard fail if extension
  // never registered). v1.8+: also return a degraded marker for
  // STALE_RECOVERED so the caller can attach _meta to the tool result.
  const preflight = runPreflight(name, args);
  if (preflight && 'isError' in preflight) return preflight;
  const degradedMeta = preflight && 'degraded' in preflight ? preflight.meta : null;

  const activity: ToolActivity = {
    requestId: randomUUID(),
    name,
    startedAt: new Date().toISOString(),
    outcome: 'running',
  };
  recentToolCalls.push(activity);
  if (recentToolCalls.length > 100) recentToolCalls.shift();
  try {
    if (WRITE_TOOL.test(name) && !name.startsWith('flow.'))
      args = await resolveWriteTab(args, signal);
    activity.tabId = args.tabId;
    // If calling a dynamic flow tool (name starts with flow.), proxy to common flow-run tool
    if (name && name.startsWith('flow.')) {
      // We need to resolve flow by slug to ID
      try {
        const resp = await nativeMessagingHostInstance.sendRequestToExtensionAndWait(
          {},
          'rr_list_published_flows',
          20000,
        );
        const items = (resp && resp.items) || [];
        const slug = name.slice('flow.'.length);
        const match = items.find((it: any) => it.slug === slug);
        if (!match) throw new Error(`Flow not found for tool ${name}`);
        const flowArgs = { flowId: match.id, args };
        const queuedAt = Date.now();
        const proxyRes = await serialByTab(
          name,
          args,
          () =>
            nativeMessagingHostInstance.sendRequestToExtensionAndWait(
              { name: 'record_replay_flow_run', args: flowArgs },
              NativeMessageType.CALL_TOOL,
              timeoutFor('record_replay_flow_run', args),
              signal,
            ),
          () => {
            activity.queueMs = Date.now() - queuedAt;
            activity.executionStartedAt = new Date().toISOString();
          },
        );
        if (proxyRes.status === 'success') {
          activity.outcome = 'success';
          return attachDegradedMeta(proxyRes.data, degradedMeta);
        }
        activity.outcome = 'error';
        activity.error = proxyRes.error;
        return {
          content: [{ type: 'text', text: `Error calling dynamic flow tool: ${proxyRes.error}` }],
          isError: true,
        };
      } catch (err: any) {
        activity.outcome = 'error';
        activity.error = err?.message || String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Error resolving dynamic flow tool: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
    // 发送请求到Chrome扩展并等待响应
    const queuedAt = Date.now();
    const response = await serialByTab(
      name,
      args,
      () =>
        nativeMessagingHostInstance.sendRequestToExtensionAndWait(
          { name, args },
          NativeMessageType.CALL_TOOL,
          timeoutFor(name, args),
          signal,
        ),
      () => {
        activity.queueMs = Date.now() - queuedAt;
        activity.executionStartedAt = new Date().toISOString();
      },
    );
    if (response.status === 'success') {
      activity.outcome = 'success';
      return attachDegradedMeta(response.data, degradedMeta);
    } else {
      activity.outcome = 'error';
      activity.error = response.error;
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: ${response.error}`,
          },
        ],
        isError: true,
      };
    }
  } catch (error: any) {
    activity.outcome = error.message === 'Request cancelled' ? 'cancelled' : 'error';
    activity.error = error.message;
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  } finally {
    activity.elapsedMs = Date.now() - new Date(activity.startedAt).getTime();
  }
};
