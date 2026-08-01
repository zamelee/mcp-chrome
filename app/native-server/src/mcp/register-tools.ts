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
 */
/**
 * @internal exported solely so unit tests can drive the decision tree without
 * spinning up a full MCP server. Production code reaches it indirectly via
 * handleToolCall.
 */
export function runPreflight(
  name: string,
  args: any,
): { isError: true; content: Array<{ type: 'text'; text: string }> } | null {
  const conn = getLatestExtensionConnection();
  const level = safetyLevelFor(name);

  // Safe tools do not depend on extension state at all.
  if (level === SafetyLevel.Safe) return null;

  // TabBound + CdpBound both need a live extension heartbeat.
  if (!conn) {
    return errorResult(name, 'SESSION_EXPIRED', 'extension has not registered since bridge start');
  }
  const heartbeatStaleMs = 5_000;
  if (Date.now() - conn.lastHeartbeat > heartbeatStaleMs) {
    return errorResult(
      name,
      'SESSION_EXPIRED',
      `last heartbeat ${Math.round((Date.now() - conn.lastHeartbeat) / 1000)}s ago`,
    );
  }

  // CdpBound additionally checks the live target set when the tool passes a targetId.
  if (level === SafetyLevel.CdpBound) {
    const targetId = typeof args?.targetId === 'string' ? args.targetId : undefined;
    if (targetId && !conn.liveTargets.has(targetId)) {
      return errorResult(
        name,
        'SESSION_EXPIRED',
        `CDP target ${targetId} not in live set (extension reloaded?)`,
      );
    }
  }

  return null;
}

function errorResult(
  toolName: string,
  code: 'SESSION_EXPIRED' | 'TAB_GONE',
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

const handleToolCall = async (
  name: string,
  args: any,
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  // Plan 1.4: preflight - refuse the call with a structured SESSION_EXPIRED
  // error if the extension has not been heard from recently. This stops the
  // previous silent-corruption failure mode where a stale MCP session id kept
  // sending CDP requests at a dead extension after `chrome://extensions`
  // reloaded the extension.
  const preflight = runPreflight(name, args);
  if (preflight) return preflight;

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
          return proxyRes.data;
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
      return response.data;
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
