/**
 * Bridge <-> extension control-plane state (Plan 1.3 + 1.4 of GO-all batch).
 *
 * Lives in its own module so that:
 *   1. server/index.ts (HTTP routes) and mcp/register-tools.ts (MCP tool
 *      dispatch) can both read it without forming an import cycle.
 *   2. The state survives any single-file refactor without changing the
 *      on-the-wire contract for /internal/register and /internal/heartbeat.
 *
 * Wire shape:
 *   POST /internal/register     { extensionId, version, liveTargets }
 *   POST /internal/heartbeat    { extensionId, liveTargets }   (every ~60s)
 *
 * Both endpoints reply with the current bridgeInstanceId so the extension can
 * detect that the bridge itself was restarted (e.g. after a reload of the
 * extension caused the bridge to exit).
 */

export interface ExtensionConnection {
  extensionId: string;
  version: string;
  connectedAt: number;
  lastHeartbeat: number;
  liveTargets: Set<string>;
}

// Module-singleton state. Reset only on bridge process restart; survives
// per-connection register/heartbeat churn within a single process lifetime.
const extensionConnections = new Map<string, ExtensionConnection>();

export function recordExtensionConnection(
  extensionId: string,
  opts: { version?: string; liveTargets: string[]; markHeartbeat: boolean },
  nowMs: number = Date.now(),
): ExtensionConnection {
  const existing = extensionConnections.get(extensionId);
  const conn: ExtensionConnection = {
    extensionId,
    version: opts.version ?? existing?.version ?? 'unknown',
    connectedAt: existing?.connectedAt ?? nowMs,
    lastHeartbeat: opts.markHeartbeat ? nowMs : (existing?.lastHeartbeat ?? nowMs),
    liveTargets: new Set(opts.liveTargets),
  };
  extensionConnections.set(extensionId, conn);
  return conn;
}

export function getExtensionConnection(extensionId: string): ExtensionConnection | undefined {
  return extensionConnections.get(extensionId);
}

/**
 * Returns the freshest ExtensionConnection by lastHeartbeat, or undefined
 * if no extension has registered yet.
 */
export function getLatestExtensionConnection(): ExtensionConnection | undefined {
  let latest: ExtensionConnection | undefined;
  for (const conn of extensionConnections.values()) {
    if (!latest || conn.lastHeartbeat > latest.lastHeartbeat) {
      latest = conn;
    }
  }
  return latest;
}

/**
 * Test-only escape hatch. DO NOT call from production code.
 */
export function _resetControlStateForTests(): void {
  extensionConnections.clear();
}
