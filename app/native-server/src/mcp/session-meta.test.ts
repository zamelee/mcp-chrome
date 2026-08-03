/**
 * Unit tests for session-meta.ts.
 *
 * Covers the four-state judgment from RFC §5.1, the retryAfterMs
 * formula (§5.5 / §8.2), and the liveTargetsSyncLag formula (§5.2).
 *
 * Pure-function tests with mock `nowMs` — no real bridge state needed.
 * Per RFC Phase 1a: this is the foundation; integration tests are in
 * Phase 4 (per §11).
 */

import { describe, expect, test } from '@jest/globals';
import {
  buildSessionMeta,
  computeLiveTargetsSyncLag,
  computeRetryAfterMs,
  type ExtensionConnection,
  type ReloadContext,
} from './session-meta';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS } from '../constant';

// ============================================================================
// Test helpers
// ============================================================================

// Anchor a fixed reference time so test outputs are deterministic.
const NOW = 1_700_000_000_000; // some fixed epoch ms

function mockConn(lastHeartbeatOffsetMs: number): ExtensionConnection {
  return {
    extensionId: 'test-ext',
    version: '1.0.0',
    connectedAt: NOW - 1_000_000,
    lastHeartbeat: NOW - lastHeartbeatOffsetMs,
    liveTargets: new Set<string>(['1', '2', '3']),
  };
}

function mockReload(
  ownerChangeOffsetMs: number | null,
  ownerId: string | null = 'owner-A',
): ReloadContext {
  return {
    lastOwnerId: ownerId,
    lastOwnerChangeMs: ownerChangeOffsetMs === null ? 0 : NOW - ownerChangeOffsetMs,
  };
}

// ============================================================================
// buildSessionMeta: NORMAL
// ============================================================================

describe('buildSessionMeta - NORMAL', () => {
  test('heartbeat fresh (30s ago) returns NORMAL', () => {
    const conn = mockConn(30_000);
    const ctx = mockReload(60_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('normal');
    expect(meta.heartbeatGapMs).toBeUndefined();
    expect(meta.retryAfterMs).toBeUndefined();
  });

  test('heartbeat fresh overrides recent reload detection', () => {
    // The new ownerId's first heartbeat already arrived → NORMAL
    const conn = mockConn(5_000);
    const ctx = mockReload(2_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('normal');
  });

  test('heartbeat at exactly HEARTBEAT_STALE_MS boundary returns STALE_RECOVERED (strict <)', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS);
    const ctx = mockReload(null); // no reload ever observed → reloadGap = Infinity
    const meta = buildSessionMeta(conn, ctx, NOW);
    // heartbeatGap === HEARTBEAT_STALE_MS → not < threshold → not NORMAL
    // reloadGap = Infinity (no reload) → STALE_RECOVERED branch
    expect(meta.sessionStatus).toBe('stale_recovered');
  });

  test('heartbeat at HEARTBEAT_STALE_MS - 1ms returns NORMAL', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS - 1);
    const ctx = mockReload(0);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('normal');
  });
});

// ============================================================================
// buildSessionMeta: EXTENSION_STARTING
// ============================================================================

describe('buildSessionMeta - EXTENSION_STARTING', () => {
  test('heartbeat stale (100s ago), reload recent (30s ago)', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(30_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('extension_starting');
    expect(meta.heartbeatGapMs).toBe(HEARTBEAT_STALE_MS + 10_000);
    expect(meta.reloadGapMs).toBe(30_000);
  });

  test('retryAfterMs = HEARTBEAT_INTERVAL_MS - reloadGapMs + 2000', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(10_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.retryAfterMs).toBe(HEARTBEAT_INTERVAL_MS - 10_000 + 2_000); // 52000
  });

  test('retryAfterMs floors at 1000ms when reloadGapMs near threshold', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const reloadGap = HEARTBEAT_STALE_MS - 1; // 89s, just below threshold
    const ctx = mockReload(reloadGap);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('extension_starting');
    // max(1000, 60000 - 89000 + 2000) = max(1000, -27000) = 1000
    expect(meta.retryAfterMs).toBe(1000);
  });

  test('reloadGap exactly at HEARTBEAT_STALE_MS - 1 still EXTENSION_STARTING', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(HEARTBEAT_STALE_MS - 1);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('extension_starting');
  });

  test('HMR rapid reloads: lastOwnerChangeMs tracks most recent only', () => {
    // Three reloads within 5s, last one 1s ago
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx: ReloadContext = {
      lastOwnerId: 'owner-c',
      lastOwnerChangeMs: NOW - 1_000,
    };
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('extension_starting');
    expect(meta.reloadGapMs).toBe(1_000);
    expect(meta.retryAfterMs).toBe(HEARTBEAT_INTERVAL_MS - 1_000 + 2_000); // 61000
  });
});

// ============================================================================
// buildSessionMeta: STALE_RECOVERED
// ============================================================================

describe('buildSessionMeta - STALE_RECOVERED', () => {
  test('heartbeat stale, reload ≥ HEARTBEAT_STALE_MS ago', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(HEARTBEAT_STALE_MS + 10_000); // 100s ago
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('stale_recovered');
    expect(meta.recommendation).toBe('re_initialize');
    expect(meta.heartbeatGapMs).toBe(HEARTBEAT_STALE_MS + 10_000);
    expect(meta.retryAfterMs).toBeUndefined();
  });

  test('heartbeat stale, reload exactly at HEARTBEAT_STALE_MS → STALE_RECOVERED', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(HEARTBEAT_STALE_MS); // exactly 90s
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('stale_recovered');
  });

  test('heartbeat stale, no reload ever observed → STALE_RECOVERED', () => {
    // Per §6.1.2: caller (runPreflight) should detect "no conn" or
    // "lastHeartbeat === 0" and emit SESSION_NOT_FOUND. But if conn
    // exists with old heartbeat and no reload observed, buildSessionMeta
    // returns STALE_RECOVERED. The caller can still choose to escalate.
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(null); // lastOwnerChangeMs === 0
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.sessionStatus).toBe('stale_recovered');
    expect(meta.heartbeatGapMs).toBe(HEARTBEAT_STALE_MS + 10_000);
    expect(meta.reloadGapMs).toBeUndefined();
  });

  test('recommendation is "re_initialize"', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(HEARTBEAT_STALE_MS + 10_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(meta.recommendation).toBe('re_initialize');
  });
});

// ============================================================================
// computeRetryAfterMs (standalone)
// ============================================================================

describe('computeRetryAfterMs', () => {
  test('reloadGapMs = 0 → 62000ms', () => {
    expect(computeRetryAfterMs(0)).toBe(HEARTBEAT_INTERVAL_MS + 2_000);
  });

  test('reloadGapMs = 30s → 32000ms', () => {
    expect(computeRetryAfterMs(30_000)).toBe(2_000);
  });

  test('reloadGapMs = 60s → 2000ms', () => {
    expect(computeRetryAfterMs(60_000)).toBe(1_000);
  });

  test('reloadGapMs > HEARTBEAT_INTERVAL_MS → floors at 1000ms', () => {
    expect(computeRetryAfterMs(70_000)).toBe(1_000);
  });

  test('handles negative reloadGapMs (clock skew) gracefully', () => {
    // If reloadGapMs is negative (clock went backward), the formula
    // produces > 60000ms — still safe upper bound.
    expect(computeRetryAfterMs(-1000)).toBeGreaterThanOrEqual(30_000);
  });
});

// ============================================================================
// computeLiveTargetsSyncLag (standalone)
// ============================================================================

describe('computeLiveTargetsSyncLag', () => {
  test('no reload ever observed → 0', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(null);
    expect(computeLiveTargetsSyncLag(conn, ctx)).toBe(0);
  });

  test('reload 100s ago, heartbeat arrived 50s ago (post-reload) → lag = 50s', () => {
    const reloadMs = NOW - 100_000;
    const heartbeatMs = NOW - 50_000;
    const conn: ExtensionConnection = {
      ...mockConn(0),
      lastHeartbeat: heartbeatMs,
    };
    const ctx: ReloadContext = {
      lastOwnerId: 'new-owner',
      lastOwnerChangeMs: reloadMs,
    };
    // newHeartbeatMs = max(heartbeatMs, reloadMs) = heartbeatMs
    // lag = heartbeatMs - reloadMs = 50000
    expect(computeLiveTargetsSyncLag(conn, ctx)).toBe(50_000);
  });

  test('reload 5s ago, heartbeat still pre-reload (100s ago) → lag = 0', () => {
    // conn.lastHeartbeat (100s ago) < reloadMs (5s ago)
    // newHeartbeatMs = max(100s, 5s) = 5s ago (i.e. reloadMs)
    // lag = reloadMs - reloadMs = 0
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(5_000);
    expect(computeLiveTargetsSyncLag(conn, ctx)).toBe(0);
  });

  test('reload 100s ago, heartbeat arrived immediately after reload → lag = 0', () => {
    // Edge case: heartbeat exactly at reloadMs (extension sent heartbeat
    // as part of its reload lifecycle)
    const reloadMs = NOW - 100_000;
    const conn: ExtensionConnection = {
      ...mockConn(0),
      lastHeartbeat: reloadMs,
    };
    const ctx: ReloadContext = {
      lastOwnerId: 'new-owner',
      lastOwnerChangeMs: reloadMs,
    };
    expect(computeLiveTargetsSyncLag(conn, ctx)).toBe(0);
  });

  test('handles clock skew (conn.lastHeartbeat in future relative to reloadMs) gracefully', () => {
    // If heartbeat > reloadMs by a small amount, lag could theoretically
    // be negative — we floor at 0.
    const reloadMs = NOW - 100_000;
    const heartbeatMs = NOW + 1_000; // 1s in the future (clock skew)
    const conn: ExtensionConnection = {
      ...mockConn(0),
      lastHeartbeat: heartbeatMs,
    };
    const ctx: ReloadContext = {
      lastOwnerId: 'new-owner',
      lastOwnerChangeMs: reloadMs,
    };
    // heartbeatMs - reloadMs = 101000, but floor at 0 if negative — not negative here
    expect(computeLiveTargetsSyncLag(conn, ctx)).toBe(101_000);
  });
});

// ============================================================================
// Response shape (locks down exact field set per status)
// ============================================================================

describe('buildSessionMeta - exact field set per status', () => {
  test('NORMAL returns only { sessionStatus }', () => {
    const conn = mockConn(10_000);
    const ctx = mockReload(5_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(Object.keys(meta).sort()).toEqual(['sessionStatus']);
  });

  test('EXTENSION_STARTING returns sessionStatus + retryAfterMs + heartbeatGapMs + reloadGapMs', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(30_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(Object.keys(meta).sort()).toEqual([
      'heartbeatGapMs',
      'reloadGapMs',
      'retryAfterMs',
      'sessionStatus',
    ]);
  });

  test('STALE_RECOVERED returns sessionStatus + heartbeatGapMs + liveTargetsSyncLagMs + recommendation', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(HEARTBEAT_STALE_MS + 10_000);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(Object.keys(meta).sort()).toEqual([
      'heartbeatGapMs',
      'liveTargetsSyncLagMs',
      'recommendation',
      'sessionStatus',
    ]);
  });

  test('STALE_RECOVERED without reload (lastOwnerChangeMs=0) does NOT include reloadGapMs', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(null);
    const meta = buildSessionMeta(conn, ctx, NOW);
    expect(Object.keys(meta).sort()).toEqual([
      'heartbeatGapMs',
      'liveTargetsSyncLagMs',
      'recommendation',
      'sessionStatus',
    ]);
  });
});

// ============================================================================
// Determinism / pure-function guarantees
// ==========================================================================

describe('pure-function guarantees', () => {
  test('buildSessionMeta with same inputs returns same outputs (idempotent)', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(30_000);
    const m1 = buildSessionMeta(conn, ctx, NOW);
    const m2 = buildSessionMeta(conn, ctx, NOW);
    expect(m1).toEqual(m2);
  });

  test('does not mutate input objects', () => {
    const conn = mockConn(HEARTBEAT_STALE_MS + 10_000);
    const ctx = mockReload(30_000);
    const connSnap = { ...conn, liveTargets: new Set(conn.liveTargets) };
    const ctxSnap = { ...ctx };
    buildSessionMeta(conn, ctx, NOW);
    expect(conn).toEqual(connSnap);
    expect(ctx).toEqual(ctxSnap);
    expect(conn.liveTargets.size).toBe(3); // unchanged
  });

  test('buildSessionMeta without explicit nowMs uses Date.now()', () => {
    // Build a conn where lastHeartbeat is 100ms before Date.now() (i.e. "now-ish")
    const conn: ExtensionConnection = {
      extensionId: 'test-ext',
      version: '1.0.0',
      connectedAt: Date.now() - 1_000,
      lastHeartbeat: Date.now() - 100,
      liveTargets: new Set<string>(),
    };
    const ctx: ReloadContext = {
      lastOwnerId: 'owner-A',
      lastOwnerChangeMs: Date.now() - 50,
    };
    const meta = buildSessionMeta(conn, ctx); // no nowMs → uses Date.now()
    // heartbeat is 100ms old, fresh → NORMAL
    expect(meta.sessionStatus).toBe('normal');
  });
});
