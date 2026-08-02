/**
 * Unit tests for reload-context.ts.
 *
 * Covers:
 *   - First observation: initialize but NOT mark as reload
 *   - Same owner: no-op (normal heartbeat)
 *   - Different owner: update lastOwnerChangeMs (reload detected)
 *   - Rapid HMR (multiple reloads in quick succession): track most recent
 *   - getReloadContext: returns a snapshot, not a live reference
 *   - _resetReloadContextForTests: clears state
 *
 * Module-singleton state; tests must call _resetReloadContextForTests
 * in beforeEach to avoid cross-test contamination.
 */

import { describe, expect, test, beforeEach } from '@jest/globals';
import { observeHeartbeat, getReloadContext, _resetReloadContextForTests } from './reload-context';

// Anchor a fixed reference time so test outputs are deterministic.
const T0 = 1_700_000_000_000; // some fixed epoch ms

// ============================================================================
// Lifecycle
// ============================================================================

describe('reload-context lifecycle', () => {
  beforeEach(() => {
    _resetReloadContextForTests();
  });

  test('initial state: never observed any owner', () => {
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBeNull();
    expect(ctx.lastOwnerChangeMs).toBe(0);
  });

  test('first observeHeartbeat sets ownerId but keeps lastOwnerChangeMs at 0 (not a reload)', () => {
    observeHeartbeat('owner-A', T0);
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-A');
    expect(ctx.lastOwnerChangeMs).toBe(0);
  });

  test('multiple identical owner observations: no reload detected (normal heartbeat)', () => {
    observeHeartbeat('owner-A', T0);
    observeHeartbeat('owner-A', T0 + 1_000);
    observeHeartbeat('owner-A', T0 + 60_000); // 60s later, normal heartbeat cadence
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-A');
    expect(ctx.lastOwnerChangeMs).toBe(0);
  });

  test('ownerId change: reload detected, lastOwnerChangeMs updated', () => {
    observeHeartbeat('owner-A', T0);
    const changeMs = T0 + 30_000;
    observeHeartbeat('owner-B', changeMs);
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-B');
    expect(ctx.lastOwnerChangeMs).toBe(changeMs);
  });

  test('back-to-owner (A → B → A): second A is also a reload', () => {
    observeHeartbeat('owner-A', T0);
    observeHeartbeat('owner-B', T0 + 10_000);
    observeHeartbeat('owner-A', T0 + 20_000);
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-A');
    expect(ctx.lastOwnerChangeMs).toBe(T0 + 20_000);
  });
});

// ============================================================================
// HMR rapid reloads
// ============================================================================

describe('reload-context HMR rapid reloads', () => {
  beforeEach(() => {
    _resetReloadContextForTests();
  });

  test('3 reloads within 5s: lastOwnerChangeMs tracks most recent only', () => {
    observeHeartbeat('owner-A', T0);
    observeHeartbeat('owner-B', T0 + 1_000);
    observeHeartbeat('owner-C', T0 + 3_000);
    observeHeartbeat('owner-D', T0 + 5_000);
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-D');
    expect(ctx.lastOwnerChangeMs).toBe(T0 + 5_000);
  });

  test('reload gap < HEARTBEAT_INTERVAL_MS is normal HMR', () => {
    observeHeartbeat('owner-A', T0);
    observeHeartbeat('owner-B', T0 + 500); // 500ms after first
    const ctx = getReloadContext();
    expect(ctx.lastOwnerChangeMs).toBe(T0 + 500);
  });
});

// ============================================================================
// Snapshot semantics
// ============================================================================

describe('reload-context snapshot semantics', () => {
  beforeEach(() => {
    _resetReloadContextForTests();
  });

  test('getReloadContext returns a snapshot, not a live reference', () => {
    observeHeartbeat('owner-A', T0);
    const snap1 = getReloadContext();
    expect(snap1.lastOwnerId).toBe('owner-A');
    expect(snap1.lastOwnerChangeMs).toBe(0);

    // Mutate state — snapshot should NOT change
    observeHeartbeat('owner-B', T0 + 1_000);

    expect(snap1.lastOwnerId).toBe('owner-A');
    expect(snap1.lastOwnerChangeMs).toBe(0);

    // But a NEW snapshot reflects the new state
    const snap2 = getReloadContext();
    expect(snap2.lastOwnerId).toBe('owner-B');
    expect(snap2.lastOwnerChangeMs).toBe(T0 + 1_000);
  });

  test('observeHeartbeat without explicit nowMs uses Date.now()', () => {
    observeHeartbeat('owner-A');
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-A');
    expect(ctx.lastOwnerChangeMs).toBe(0);
    // No precise assertion on lastOwnerChangeMs — uses real Date.now()
  });
});

// ============================================================================
// Reset semantics
// ============================================================================

describe('reload-context reset', () => {
  beforeEach(() => {
    _resetReloadContextForTests();
  });

  test('_resetReloadContextForTests clears all state', () => {
    observeHeartbeat('owner-A', T0);
    observeHeartbeat('owner-B', T0 + 1_000);
    let ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-B');
    expect(ctx.lastOwnerChangeMs).toBe(T0 + 1_000);

    _resetReloadContextForTests();

    ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBeNull();
    expect(ctx.lastOwnerChangeMs).toBe(0);
  });

  test('after reset, first observation is treated as fresh (not a reload)', () => {
    observeHeartbeat('owner-A', T0);
    observeHeartbeat('owner-B', T0 + 1_000);
    _resetReloadContextForTests();

    observeHeartbeat('owner-A', T0 + 2_000);
    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-A');
    expect(ctx.lastOwnerChangeMs).toBe(0);
  });
});
