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
const HEARTBEAT_INTERVAL_MS = 60_000;

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
}

function startHeartbeat(): void {
  stopHeartbeat();
  state.timer = setInterval(() => {
    void doHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  // No .unref() in MV3 service workers — keep the timer alive.
}

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
