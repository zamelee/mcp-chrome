/**
 * Bridge control plane client (Plan 2.2 + 2.3 of GO-all batch).
 *
 * Lives in the extension background service worker. After the bridge confirms
 * `SERVER_STARTED` we POST /internal/register so the bridge knows our
 * extensionId + version + live tab list, then we heartbeat every ~60s with a
 * refreshed snapshot. The bridge uses this to power its Plan 1.4 tool
 * preflight: a stale snapshot means the extension was reloaded, so any
 * in-flight CDP target is dead and we want clients to see SESSION_EXPIRED
 * instead of silent corruption.
 *
 * Wire shape (matches app/native-server/src/server/index.ts):
 *   POST /internal/register     { extensionId, version, liveTargets }
 *   POST /internal/heartbeat    { extensionId, liveTargets }   (every ~60s)
 */

const REGISTER_PATH = '/internal/register';
const HEARTBEAT_PATH = '/internal/heartbeat';
const HEARTBEAT_INTERVAL_MS = 30_000;
// v1.8.2: alarm 30s wakes SW even after MV3 idle freeze; setInterval 30s is the
// backup for when SW is alive. Both fire the same idempotent doHeartbeat().
// Native-side HEARTBEAT_STALE_MS = 150s gives 5x jitter tolerance (R2 ChatGPT
// math: 70s alarm + 5s SW cold start + 5s network + 1s bridge + 69s margin).
const HEARTBEAT_ALARM_NAME = 'bridge-heartbeat';

// v1.8+ soft degradation (RFC §6.1.4): include ownerId in heartbeat body
// so bridge can detect SW reload events.
import { getV3Runtime } from './record-replay-v3/bootstrap';

type BridgeHealth = {
  bridgeInstanceId: string;
  serverStartedAt: number;
};

type ControlState = {
  port: number | null;
  extensionId: string;
  version: string;
  timer: ReturnType<typeof setInterval> | null;
  inflightRegister: Promise<void> | null;
};

const state: ControlState = {
  port: null,
  extensionId: '',
  version: '',
  timer: null,
  inflightRegister: null,
};

async function fetchLiveTargets(): Promise<string[]> {
  // Best-effort tab list as string IDs. We use tab IDs (not CDP target IDs)
  // because chrome.tabs.query works without any debugger.attach, while CDP
  // targets only exist once some caller has attached a debugger session.
  // The bridge uses these as L1 identifiers for preflight; CDP target
  // identity is recovered separately when needed.
  try {
    // @ts-expect-error chrome.* is provided by the extension runtime.
    const tabs = await chrome.tabs.query({});
    if (!Array.isArray(tabs)) return [];
    return tabs
      .map((t: { id?: number }) => (typeof t?.id === 'number' ? String(t.id) : null))
      .filter((s: string | null): s is string => s !== null);
  } catch {
    return [];
  }
}

async function postJson(path: string, body: unknown): Promise<BridgeHealth | null> {
  if (state.port === null) return null;
  const url = `http://127.0.0.1:${state.port}${path}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as BridgeHealth & { success?: boolean };
    if (json && typeof json.bridgeInstanceId === 'string') {
      return { bridgeInstanceId: json.bridgeInstanceId, serverStartedAt: json.serverStartedAt };
    }
    return null;
  } catch {
    return null;
  }
}

async function doRegister(): Promise<BridgeHealth | null> {
  const liveTargets = await fetchLiveTargets();
  const ack = await postJson(REGISTER_PATH, {
    extensionId: state.extensionId,
    version: state.version,
    liveTargets,
    ownerId: getV3Runtime()?.ownerId ?? null,
  });
  if (ack) {
    console.log(
      `[bridge-control] registered bridge=${ack.bridgeInstanceId} tabs=${liveTargets.length}`,
    );
  } else {
    console.warn('[bridge-control] register ack missing');
  }
  return ack;
}

async function doHeartbeat(): Promise<void> {
  const liveTargets = await fetchLiveTargets();
  const ack = await postJson(HEARTBEAT_PATH, {
    extensionId: state.extensionId,
    liveTargets,
    ownerId: getV3Runtime()?.ownerId ?? null,
  });
  if (ack) {
    console.debug(
      `[bridge-control] heartbeat bridge=${ack.bridgeInstanceId} tabs=${liveTargets.length}`,
    );
  }
}

function stopHeartbeat(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  // v1.8.2: also clear the alarm so a stopped heartbeat loop is not woken
  // by an outstanding alarm (e.g. after bridge disconnect during dev).
  void chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
}

// ===========================================================================
// Tab event listeners (v1.7.3 - Plan 2.3 follow-up)
// ===========================================================================
// Without these, bridge preflight (Plan 1.4) hits `Tab N not in live set`
// SESSION_EXPIRED for any tab opened via a bridge tool until the next 60s
// heartbeat cycle includes the new tabId. Fix: trigger an immediate
// heartbeat on tab lifecycle events so the bridge sees the new tabId
// within milliseconds (one round-trip), not up to 60s later.
//
// MV3 SW lifecycle note: chrome.tabs.* events that fire while the SW
// is asleep are dropped (MV3 does not queue events). When the SW wakes
// up, the listeners re-attach at module load and the initial heartbeat
// captures the current tab set. This is fine because the bridge
// preflight only fires after onBridgeStarted() which kicks off register
// + initial heartbeat synchronously.
//
// We attach listeners at module load (not inside startHeartbeat) because
// chrome.tabs.* listeners accumulate across calls -- addListener without
// removeListener would compound if startHeartbeat is called repeatedly.
// Attach-once + active-flag-check is the safest pattern.
function triggerImmediateHeartbeatIfActive(): void {
  if (!state.timer) return; // heartbeat not active, skip
  void doHeartbeat();
}

chrome.tabs.onCreated.addListener(triggerImmediateHeartbeatIfActive);
chrome.tabs.onRemoved.addListener(triggerImmediateHeartbeatIfActive);
chrome.tabs.onAttached.addListener(triggerImmediateHeartbeatIfActive); // tab moved between windows
chrome.tabs.onDetached.addListener(triggerImmediateHeartbeatIfActive); // tab moved between windows
chrome.tabs.onReplaced.addListener(triggerImmediateHeartbeatIfActive); // prerender swap

function startHeartbeat(): void {
  stopHeartbeat();
  state.timer = setInterval(() => {
    void doHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  // No .unref() in MV3 service workers — keep the timer alive.

  // v1.8.2: chrome.alarms 30s wakes the SW even after MV3 idle freeze (30s+ of
  // no user activity). setInterval dies with the SW; alarm survives. Both fire
  // the same idempotent doHeartbeat(), so a redundant call is harmless.
  // chrome.alarms minimum periodInMinutes is 0.5 on Chrome >= 120 (we use 134+).
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 });
}
// chrome.tabs.* listeners are attached at module load above so the bridge
// sees tab lifecycle events immediately. triggerImmediateHeartbeatIfActive
// guards against firing before the heartbeat loop is started.

// v1.8.2: alarm listener. Attached at module load (one-shot, never double-bind)
// because chrome.alarms.onAlarm.addListener accumulates across hot-reloads.
// The same triggerImmediateHeartbeatIfActive guard prevents firing when the
// heartbeat loop has been stopped via onBridgeStopped().
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM_NAME) return;
  triggerImmediateHeartbeatIfActive();
});

/**
 * Called by native-host.ts whenever the bridge confirms SERVER_STARTED on a
 * given port. This kicks off register + heartbeat loop. Safe to call multiple
 * times: a concurrent call is deduped via the inflightRegister promise, and a
 * port change triggers a fresh registration cycle.
 */
export async function onBridgeStarted(port: number): Promise<void> {
  if (state.port === port && state.timer) return;
  state.port = port;
  state.extensionId = chrome.runtime?.id ?? state.extensionId;
  state.version = chrome.runtime?.getManifest?.()?.version ?? state.version;

  // Cancel any in-flight register before starting a new one.
  state.inflightRegister = (async () => {
    const ack = await doRegister();
    if (!ack) {
      console.warn(
        `[bridge-control] bridge did not ack register on port=${port}; will retry via heartbeat`,
      );
      return;
    }
    startHeartbeat();
    // Fire one heartbeat immediately so the bridge has a fresh snapshot now
    // rather than waiting HEARTBEAT_INTERVAL_MS.
    void doHeartbeat();
  })();
  try {
    await state.inflightRegister;
  } finally {
    state.inflightRegister = null;
  }
}

/**
 * Called by native-host.ts whenever the bridge connection drops (port null,
 * SERVER_STOPPED, or onDisconnect). Stops the heartbeat timer so we don't
 * hammer a dead bridge. Next onBridgeStarted() will resume the loop.
 */
export function onBridgeStopped(): void {
  stopHeartbeat();
  state.port = null;
}

/**
 * Test-only escape hatch. DO NOT call from production code.
 */
export function _resetControlStateForTests(): void {
  stopHeartbeat();
  state.port = null;
  state.extensionId = '';
  state.version = '';
  state.inflightRegister = null;
}
