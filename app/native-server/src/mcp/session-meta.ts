/**
 * Bridge-side MCP session lifecycle metadata.
 *
 * Implements the four-state judgment from
 * `docs/rfcs/2026-08-02-mcp-session-soft-degradation.md` §5.1:
 *
 *   - NORMAL              : heartbeat fresh (< HEARTBEAT_STALE_MS ago)
 *   - EXTENSION_STARTING  : heartbeat stale, reload detected recently (< HEARTBEAT_STALE_MS ago)
 *   - STALE_RECOVERED     : heartbeat stale, reload ≥ HEARTBEAT_STALE_MS ago (or never detected)
 *   - SESSION_NOT_FOUND   : conn never registered (caller-level concern; not returned here)
 *
 * Pure functions — no module state. Trivial to unit-test with mock data.
 *
 * Naming convention (per RFC §5.2):
 *   - snake_case (e.g. `stale_recovered`) for actual values used in code / `_meta`
 *   - SCREAMING_SNAKE_CASE (e.g. `STALE_RECOVERED`) for prose / table labels
 */

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS } from '../constant';
import type { ExtensionConnection } from '../control-state';

// ============================================================================
// Types
// ============================================================================

// Re-export ExtensionConnection so callers of buildSessionMeta can import
// the type from session-meta.ts without needing to know about control-state.ts.
export type { ExtensionConnection };

/**
 * Reload detection state, owned by `ReloadContextTracker` (Phase 1b).
 *
 * `lastOwnerChangeMs === 0` means no reload has ever been observed (i.e. the
 * extension has been alive since bridge start, OR bridge has never seen
 * a heartbeat, OR reload was before bridge started tracking — all collapse
 * to the same "no signal" semantics).
 */
export interface ReloadContext {
  /** ownerId that the bridge most recently observed; null if no heartbeat yet. */
  lastOwnerId: string | null;
  /** Timestamp (ms since epoch) of last ownerId change. 0 = never observed. */
  lastOwnerChangeMs: number;
}

/**
 * Result of `buildSessionMeta`. Attached to MCP tool-call results as
 * `result._meta` when `sessionStatus !== 'normal'`.
 */
export interface McpSessionMeta {
  /**
   * Session state. Always one of:
   *   'normal' | 'stale_recovered' | 'extension_starting'
   *
   * SESSION_NOT_FOUND is intentionally NOT a status here — it's a caller-
   * level decision when `conn` itself is null/undefined (no extension
   * has ever registered via `/internal/register`). Per `control-state.ts`,
   * `conn.lastHeartbeat === 0` is impossible because
   * `recordExtensionConnection` always sets `lastHeartbeat = nowMs` on
   * registration. See `runPreflight` in `register-tools.ts` §6.1.2 of the RFC.
   */
  sessionStatus: 'normal' | 'stale_recovered' | 'extension_starting';

  /** heartbeatGapMs (only when stale) */
  heartbeatGapMs?: number;
  /** reloadGapMs (only when extension_starting) */
  reloadGapMs?: number;

  /**
   * STALE_RECOVERED: estimated delay between reload and liveTargets being
   * synced from the new extension. See `computeLiveTargetsSyncLag`.
   */
  liveTargetsSyncLagMs?: number;

  /** STALE_RECOVERED: client should re-initialize for fresh session metadata. */
  recommendation?: 're_initialize';

  /**
   * EXTENSION_STARTING: client should sleep this many ms then retry.
   * Always >= 1000 (floor). Caps at HEARTBEAT_INTERVAL_MS when reloadGapMs ≈ 0.
   */
  retryAfterMs?: number;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute the session metadata for the current request.
 *
 * Pure function: no I/O, no module state. The caller passes `nowMs` for
 * deterministic testing; defaults to `Date.now()` in production.
 *
 * Algorithm (matches RFC §5.1 decision tree):
 *
 *   1. heartbeatGap < HEARTBEAT_STALE_MS  → NORMAL (regardless of reload)
 *   2. reloadGap < HEARTBEAT_STALE_MS     → EXTENSION_STARTING
 *   3. otherwise                          → STALE_RECOVERED
 *
 * SESSION_NOT_FOUND is handled by the caller (runPreflight) before this
 * function is invoked.
 *
 * @param conn           current extension connection from control-state.ts.
 *                          Caller must guarantee this is defined (i.e., an
 *                          extension has registered). For the
 *                          SESSION_NOT_FOUND case, caller does not invoke
 *                          this function.
 * @param reloadContext  ownerId tracking state (owned by ReloadContextTracker in Phase 1b)
 * @param nowMs          reference timestamp for deterministic tests
 */
export function buildSessionMeta(
  conn: ExtensionConnection,
  reloadContext: ReloadContext,
  nowMs: number = Date.now(),
): McpSessionMeta {
  const heartbeatGapMs = nowMs - conn.lastHeartbeat;

  // Fast path: heartbeat fresh → NORMAL regardless of reload state.
  // The heartbeat itself proves the extension is alive (even if ownerId
  // changed recently — the new owner's first heartbeat already arrived).
  if (heartbeatGapMs < HEARTBEAT_STALE_MS) {
    return { sessionStatus: 'normal' };
  }

  // heartbeatGap >= HEARTBEAT_STALE_MS → stale.
  // Branch on reload detection.
  // - No reload ever observed (lastOwnerChangeMs === 0) → treat as
  //   reloadGap = +Infinity so we fall through to STALE_RECOVERED.
  //   (caller should still emit SESSION_NOT_FOUND if conn never registered;
  //   buildSessionMeta doesn't make that judgment.)
  // - Reload observed recently → EXTENSION_STARTING.
  // - Reload observed long ago → STALE_RECOVERED.
  const reloadGapMs =
    reloadContext.lastOwnerChangeMs > 0
      ? nowMs - reloadContext.lastOwnerChangeMs
      : Number.POSITIVE_INFINITY;

  if (reloadGapMs < HEARTBEAT_STALE_MS) {
    return {
      sessionStatus: 'extension_starting',
      retryAfterMs: computeRetryAfterMs(reloadGapMs),
      heartbeatGapMs,
      reloadGapMs,
    };
  }

  return {
    sessionStatus: 'stale_recovered',
    heartbeatGapMs,
    liveTargetsSyncLagMs: computeLiveTargetsSyncLag(conn, reloadContext, nowMs),
    recommendation: 're_initialize',
  };
}

/**
 * Compute "client should sleep this many ms then retry" for an
 * EXTENSION_STARTING response.
 *
 * Formula (RFC §5.5, §8.2):
 *
 *   retryAfterMs = max(1000, HEARTBEAT_INTERVAL_MS - reloadGapMs + 2000)
 *
 * Intuition: wait until the next expected heartbeat, plus a 2s safety
 * margin for clock skew / scheduling latency. Floor at 1s so we never
 * hand back a "retry immediately" that would just hit EXTENSION_STARTING
 * again (which would correctly transition to STALE_RECOVERED once
 * reloadGapMs reaches HEARTBEAT_STALE_MS).
 *
 * Exported for testability and for direct use by callers that want to
 * expose retry timing on error responses.
 */
export function computeRetryAfterMs(reloadGapMs: number): number {
  return Math.max(1000, HEARTBEAT_INTERVAL_MS - reloadGapMs + 2_000);
}

/**
 * Estimated delay between extension reload and liveTargets being
 * synced from the new extension.
 *
 * Algorithm (RFC §5.2 / §6.1.1):
 *   - If no reload ever observed: 0 (no lag to measure)
 *   - Otherwise: lastSyncMs - reloadMs
 *     where lastSyncMs = max(conn.lastHeartbeat, reloadContext.lastOwnerChangeMs)
 *   - Floor at 0 (defensive: time-travel / clock skew shouldn't yield negative)
 *
 * Why `max(conn.lastHeartbeat, reloadMs)`:
 *   - Pre-reload heartbeat: conn.lastHeartbeat < reloadMs → use reloadMs
 *     (reload itself is the latest signal we have for "extension started")
 *   - Post-reload heartbeat: conn.lastHeartbeat >= reloadMs → use that
 *     (the new heartbeat carried the fresh liveTargets)
 *
 * No `nowMs` parameter: the formula is self-contained with the two
 * timestamps. `nowMs` would only be needed for the impossible edge case
 * where neither timestamp has been recorded (handled by the early return).
 */
export function computeLiveTargetsSyncLag(
  conn: ExtensionConnection,
  reloadContext: ReloadContext,
): number {
  if (reloadContext.lastOwnerChangeMs === 0) return 0;
  const lastSyncMs = Math.max(conn.lastHeartbeat, reloadContext.lastOwnerChangeMs);
  return Math.max(0, lastSyncMs - reloadContext.lastOwnerChangeMs);
}
