/**
 * Tracks Chrome extension SW reload events via ownerId observation.
 *
 * Part of the MCP session soft-degradation protocol (RFC §6.1.4):
 * - Extension SW generates a new `ownerId` on every reload (visible in
 *   `[RR-V3] Bootstrap complete, ownerId: ...` log line, see
 *   `app/chrome-extension/entrypoints/background/record-replay-v3/bootstrap.ts`)
 * - Extension includes ownerId in `/internal/heartbeat` POST body (Phase 3)
 * - Bridge calls `observeHeartbeat(ownerId)` on each heartbeat
 * - `getReloadContext()` returns a snapshot for `buildSessionMeta`
 *   (Phase 1a) to compute `EXTENSION_STARTING` vs `STALE_RECOVERED`
 *
 * Module-singleton state (matches `control-state.ts` pattern). Survives
 * within a single bridge process; reset only on bridge restart or test.
 *
 * Thread-safety: JavaScript is single-threaded in the bridge (no concurrent
 * `observeHeartbeat` calls), so no locking needed.
 */

import type { ReloadContext } from './session-meta';

// Re-export ReloadContext so callers can import both from this module.
export type { ReloadContext };

// ============================================================================
// State (module-singleton)
// ============================================================================

let lastOwnerId: string | null = null;
/** ms since epoch of last ownerId change. 0 = never observed a reload. */
let lastOwnerChangeMs = 0;

// ============================================================================
// Public API
// ============================================================================

/**
 * Record an ownerId observation from a heartbeat.
 *
 * Behavior:
 *   - First observation (lastOwnerId === null): set lastOwnerId = ownerId,
 *     keep lastOwnerChangeMs at 0. "Never observed reload" semantics are
 *     preserved per RFC §5.2 — the first connection is not a reload.
 *   - Same ownerId: no-op. (Heartbeat firing 60s apart with the same owner
 *     is normal background behavior, not a reload.)
 *   - Different ownerId: this is a reload (or a brand-new bridge startup
 *     seeing its first owner — either way, update lastOwnerChangeMs so the
 *     four-state judgment can distinguish "just reloaded" from "loaded long ago").
 *
 * @param ownerId  ownerId string from the heartbeat payload
 * @param nowMs    reference timestamp for deterministic testing
 */
export function observeHeartbeat(ownerId: string, nowMs: number = Date.now()): void {
  if (lastOwnerId === null) {
    // First observation — initialize. NOT a reload.
    lastOwnerId = ownerId;
    return;
  }
  if (ownerId === lastOwnerId) {
    // Same owner — normal heartbeat, no event.
    return;
  }
  // Owner changed — this IS a reload (or equivalent boundary event).
  lastOwnerId = ownerId;
  lastOwnerChangeMs = nowMs;
}

/**
 * Snapshot of the current reload state. Pass to `buildSessionMeta` (Phase 1a)
 * for session lifecycle judgment.
 */
export function getReloadContext(): ReloadContext {
  return {
    lastOwnerId,
    lastOwnerChangeMs,
  };
}

/**
 * Test-only escape hatch. Clears all observed state. DO NOT call from
 * production code (mirrors `_resetControlStateForTests` in `control-state.ts`).
 */
export function _resetReloadContextForTests(): void {
  lastOwnerId = null;
  lastOwnerChangeMs = 0;
}
