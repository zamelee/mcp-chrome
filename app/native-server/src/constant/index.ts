export enum NATIVE_MESSAGE_TYPE {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
}

export const NATIVE_SERVER_PORT = 12306;

// Timeout constants (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
  EXTENSION_REQUEST_TIMEOUT: 20000,
  PROCESS_DATA_TIMEOUT: 20000,
} as const;

// ============================================================
// Extension heartbeat -> tool preflight threshold (Plan 1.4)
// ============================================================

/**
 * Stale threshold for the extension heartbeat check inside runPreflight /
 * assertRuntime. If Date.now() - lastHeartbeat > HEARTBEAT_STALE_MS we
 * refuse the tool call with SESSION_EXPIRED.
 *
 * MUST stay > HEARTBEAT_INTERVAL_MS (30s in bridge-control.ts since v1.8.2) so the
 * check does not fire spuriously between heartbeats. With a 30s heartbeat
 * interval and a 5s threshold (the v1.7.1 bug), ~83% of every minute was
 * SESSION_EXPIRED. 150s leaves a >75s working window after each heartbeat.
 *
 * v1.8.2 bump from 90s to 150s. Full jitter budget (RFC
 * docs/rfcs/2026-08-02-mcp-watchdog-keepalive.md):
 *
 *   alarm jitter       70s worst (not earlier than + background throttling)
 *   SW cold start        5s (complex extension JS + IndexedDB migration)
 *   network RTT          5s (localhost <10ms; remote/VPN up to 5s)
 *   bridge processing     1s (doHeartbeat -> register -> state write)
 *   margin              69s
 *   -------------------
 *   total             150s
 *
 * 150s gives 5x the 30s HEARTBEAT_INTERVAL_MS, tolerating two consecutive
 * worst-case alarm delays before declaring the extension dead.
 */
export const HEARTBEAT_STALE_MS = 150_000;

/**
 * Extension heartbeat interval (mirror of the extension-side constant
 * in `app/chrome-extension/entrypoints/background/bridge-control.ts`).
 *
 * Used by bridge-side session-meta.ts to compute retry timing:
 * `retryAfterMs = max(1000, HEARTBEAT_INTERVAL_MS - reloadGapMs + 2_000)`.
 *
 * MUST stay in sync with the extension. Drift will cause bridge to under-
 * or over-estimate how long a client should wait before retrying an
 * EXTENSION_STARTING call. If the extension changes its interval, update
 * this constant in the same release.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

// Server configuration
export const SERVER_CONFIG = {
  HOST: '127.0.0.1',
  /**
   * CORS origin whitelist - only allow Chrome/Firefox extensions and local debugging.
   * Use RegExp patterns for extension origins, string for exact match.
   */
  CORS_ORIGIN: [/^chrome-extension:\/\//, /^moz-extension:\/\//, 'http://127.0.0.1'] as const,
  LOGGER_ENABLED: false,
} as const;

// HTTP Status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
  GATEWAY_TIMEOUT: 504,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  NATIVE_HOST_NOT_AVAILABLE: 'Native host connection not established.',
  SERVER_NOT_RUNNING: 'Server is not actively running.',
  REQUEST_TIMEOUT: 'Request to extension timed out.',
  INVALID_MCP_REQUEST: 'Invalid MCP request or session.',
  INVALID_SESSION_ID: 'Invalid or missing MCP session ID.',
  INTERNAL_SERVER_ERROR: 'Internal Server Error',
  MCP_SESSION_DELETION_ERROR: 'Internal server error during MCP session deletion.',
  MCP_REQUEST_PROCESSING_ERROR: 'Internal server error during MCP request processing.',
  INVALID_SSE_SESSION: 'Invalid or missing MCP session ID for SSE.',
} as const;

// ============================================================
// Chrome MCP Server Configuration
// ============================================================

/**
 * Environment variables for dynamically resolving the local MCP HTTP endpoint.
 * CHROME_MCP_PORT is the preferred source; MCP_HTTP_PORT is kept for backward compatibility.
 */
export const CHROME_MCP_PORT_ENV = 'CHROME_MCP_PORT';
export const MCP_HTTP_PORT_ENV = 'MCP_HTTP_PORT';

/**
 * Get the actual port the Chrome MCP server is listening on.
 * Priority: CHROME_MCP_PORT env > MCP_HTTP_PORT env > NATIVE_SERVER_PORT default
 */
export function getChromeMcpPort(): number {
  const raw = process.env[CHROME_MCP_PORT_ENV] || process.env[MCP_HTTP_PORT_ENV];
  const port = raw ? Number.parseInt(String(raw), 10) : NaN;
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : NATIVE_SERVER_PORT;
}

/**
 * Get the full URL to the local Chrome MCP HTTP endpoint.
 * This URL is used by Claude/Codex agents to connect to the MCP server.
 */
export function getChromeMcpUrl(): string {
  return `http://${SERVER_CONFIG.HOST}:${getChromeMcpPort()}/mcp`;
}
