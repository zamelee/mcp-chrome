/**
 * v1.10.2: Chrome toolbar icon state machine.
 *
 * 8 IconStates mapped to pre-built PNG sets under public/icons/<state>/{16,32,48}.png.
 * State changes are throttled (250ms) + priority-ordered so a transient ERROR
 * doesn't get immediately overwritten by a quick READY.
 *
 * Priority (highest wins):
 *   ERROR      (8) > BUSY (7) > STALE (6) > SERVICE_DOWN (5) > DISCONNECTED_MANUAL (4)
 *   > DISCONNECTED_AUTO (3) > CODEX_IDLE (2) > READY (1)
 *
 * Sticky-error rule: when a new ERROR fires, lock for 5s so subsequent
 * READY heartbeats don't immediately mask it.
 */
export const ICON_STATES = [
  'READY',
  'SERVICE_DOWN',
  'DISCONNECTED_AUTO',
  'DISCONNECTED_MANUAL',
  'ERROR',
  'BUSY',
  'STALE',
  'CODEX_IDLE',
] as const;

export type IconState = typeof ICON_STATES[number];

const PRIORITY: Record<IconState, number> = {
  READY: 1,
  CODEX_IDLE: 2,
  DISCONNECTED_AUTO: 3,
  DISCONNECTED_MANUAL: 4,
  SERVICE_DOWN: 5,
  STALE: 6,
  BUSY: 7,
  ERROR: 8,
};

const BADGE_TEXT: Partial<Record<IconState, string>> = {
  SERVICE_DOWN: '!',
  DISCONNECTED_AUTO: '...',
  DISCONNECTED_MANUAL: 'X',
  ERROR: 'E',
  BUSY: '*',
  STALE: '?',
  CODEX_IDLE: '0',
};

const BADGE_BG: Partial<Record<IconState, string>> = {
  SERVICE_DOWN: '#f59e0b',     // amber-500
  DISCONNECTED_AUTO: '#787878', // gray-500
  DISCONNECTED_MANUAL: '#dc2626', // red-600
  ERROR: '#dc2626',
  BUSY: '#3b82f6',            // blue-500
  STALE: '#d97706',           // amber-600
  CODEX_IDLE: '#a855f7',      // purple-500
};

const THROTTLE_MS = 250;
const ERROR_STICKY_MS = 5000;

const pendingStates: Partial<Record<IconState, number>> = {};
let currentState: IconState | null = null;
let lastErrorAt = 0;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Effective state after applying sticky-error rule + priority selection.
 * If multiple states are pending, the highest-priority wins.
 */
function selectEffectiveState(): IconState {
  let best: IconState = currentState ?? 'READY';
  let bestPriority = best === 'READY' ? PRIORITY.READY : 0;
  for (const [state, ts] of Object.entries(pendingStates) as [IconState, number][]) {
    // Skip stale entries (older than 60s) -- probably orphaned.
    if (Date.now() - ts > 60_000) {
      delete pendingStates[state];
      continue;
    }
    const p = PRIORITY[state];
    if (p > bestPriority) {
      bestPriority = p;
      best = state;
    }
  }
  // Sticky ERROR: once ERROR fires, it wins for ERROR_STICKY_MS regardless of
  // what else is pending. Prevents transient READY heartbeats from masking
  // a real failure signal.
  if (Date.now() - lastErrorAt < ERROR_STICKY_MS && PRIORITY.ERROR >= bestPriority) {
    best = 'ERROR';
  }
  return best;
}

async function applyState(state: IconState): Promise<void> {
  try {
    await chrome.action.setIcon({
      path: {
        16: `icons/${state.toLowerCase().replace('_', '-')}/16.png`,
        32: `icons/${state.toLowerCase().replace('_', '-')}/32.png`,
        48: `icons/${state.toLowerCase().replace('_', '-')}/48.png`,
      },
    });
  } catch (e) {
    console.warn('[icon-manager] setIcon failed for', state, e);
  }
  const text = BADGE_TEXT[state] ?? '';
  if (text === '') {
    try {
      await chrome.action.setBadgeText({ text: '' });
    } catch {
      // ignore
    }
  } else {
    try {
      await chrome.action.setBadgeText({ text });
    } catch (e) {
      console.warn('[icon-manager] setBadgeText failed', e);
    }
    const bg = BADGE_BG[state];
    if (bg) {
      try {
        await chrome.action.setBadgeBackgroundColor({ color: bg });
      } catch (e) {
        console.warn('[icon-manager] setBadgeBackgroundColor failed', e);
      }
    }
  }
  currentState = state;
}

function scheduleApply(): void {
  if (throttleTimer !== null) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    const next = selectEffectiveState();
    if (next !== currentState) {
      void applyState(next);
    }
  }, THROTTLE_MS);
}

/**
 * Update the icon state. Multiple state updates within THROTTLE_MS are
 * coalesced. ERROR gets sticky treatment so a transient READY heartbeat
 * does not immediately mask it.
 */
export function setIconState(state: IconState): void {
  pendingStates[state] = Date.now();
  if (state === 'ERROR') lastErrorAt = Date.now();
  scheduleApply();
}

/**
 * Clear a state (e.g., after BUSY tool call completes).
 */
export function clearIconState(state: IconState): void {
  delete pendingStates[state];
  // If clearing the sticky ERROR state, reset the sticky timestamp too so
  // subsequent READY heartbeats are not artificially masked.
  if (state === 'ERROR') {
    lastErrorAt = 0;
  }
  scheduleApply();
}

/**
 * Force an immediate refresh (used on bridge events). Skips throttle.
 */
export function flushIconState(): void {
  if (throttleTimer !== null) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  const next = selectEffectiveState();
  if (next !== currentState) {
    void applyState(next);
  }
}

/**
 * For tests: reset internal state.
 */
export function _resetForTests(): void {
  if (throttleTimer !== null) clearTimeout(throttleTimer);
  throttleTimer = null;
  for (const k of Object.keys(pendingStates)) delete pendingStates[k as IconState];
  lastErrorAt = 0;
  currentState = null;
}

/**
 * For tests: peek current internal state.
 */
export function _currentStateForTests(): IconState | null {
  return currentState;
}