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
  /** v1.11: current bridge state (synchronized via transitionBridgeState) */
  currentState: BridgeState;
  /** v1.11: recovery telemetry counters per connection */
  recovery: RecoveryTelemetry;
}

// Module-singleton state. Reset only on bridge process restart; survives
// per-connection register/heartbeat churn within a single process lifetime.
const extensionConnections = new Map<string, ExtensionConnection>();

// ============================================================================
// v1.11: Bridge state machine (5 states) + recovery telemetry
// ============================================================================

export enum BridgeState {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  BACKOFF = 'backoff',
  RECONNECTING = 'reconnecting',
  READY = 'ready',
}

/**
 * Recovery telemetry (v1.11): module-singleton counters for /health endpoint.
 * Reset only on bridge process restart.
 */
export interface RecoveryTelemetry {
  reinitializeCount: number;
  lastReinitializeAt: number;
  disconnectCount: number;
  lastDisconnectAt: number;
  backoffAttempts: number;
  lastBackoffAt: number;
}

const recoveryTelemetry: RecoveryTelemetry = {
  reinitializeCount: 0,
  lastReinitializeAt: 0,
  disconnectCount: 0,
  lastDisconnectAt: 0,
  backoffAttempts: 0,
  lastBackoffAt: 0,
};

export function getRecoveryTelemetry(): RecoveryTelemetry {
  return { ...recoveryTelemetry };
}

/**
 * v1.11: Transition bridge state with logging (RFC §6.1.5).
 */
export function transitionBridgeState(
  newState: BridgeState,
  reason: string = '',
  nowMs: number = Date.now(),
): BridgeState {
  const currentState = bridgeState;
  if (currentState === newState) return currentState;
  bridgeState = newState;
  if (newState === BridgeState.READY || newState === BridgeState.CONNECTED) {
    if (currentState !== BridgeState.CONNECTED && currentState !== BridgeState.READY) {
      recoveryTelemetry.reinitializeCount += 1;
      recoveryTelemetry.lastReinitializeAt = nowMs;
    }
  }
  if (newState === BridgeState.DISCONNECTED) {
    recoveryTelemetry.disconnectCount += 1;
    recoveryTelemetry.lastDisconnectAt = nowMs;
  }
  if (newState === BridgeState.BACKOFF) {
    recoveryTelemetry.backoffAttempts += 1;
    recoveryTelemetry.lastBackoffAt = nowMs;
  }
  const reasonSuffix = reason ? ' (reason: ' + reason + ')' : '';
  console.log('[bridge-state] ' + currentState + ' -> ' + newState + reasonSuffix);
  return currentState;
}

export function getBridgeState(): BridgeState {
  return bridgeState;
}

// Module-singleton bridge state (separate from extensionConnections per RFC §6.1.5).
let bridgeState: BridgeState = BridgeState.DISCONNECTED;

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
    currentState: existing?.currentState ?? bridgeState,
    recovery: existing?.recovery ?? { ...recoveryTelemetry },
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
  bridgeState = BridgeState.DISCONNECTED;
  recoveryTelemetry.reinitializeCount = 0;
  recoveryTelemetry.lastReinitializeAt = 0;
  recoveryTelemetry.disconnectCount = 0;
  recoveryTelemetry.lastDisconnectAt = 0;
  recoveryTelemetry.backoffAttempts = 0;
  recoveryTelemetry.lastBackoffAt = 0;
}
