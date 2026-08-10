/**
 * Unit tests for control-state.ts (v1.11: Bridge state machine + Recovery Telemetry).
 *
 * Covers:
 *   - Initial state: DISCONNECTED, all counters 0
 *   - transitionBridgeState: same-state no-op (no counter increment)
 *   - transitionBridgeState: CONNECTED -> READY increments reinitializeCount
 *   - transitionBridgeState: -> DISCONNECTED increments disconnectCount + ts
 *   - transitionBridgeState: -> BACKOFF increments backoffAttempts + ts
 *   - getRecoveryTelemetry: returns a snapshot, not a live reference
 *   - getBridgeState: returns current state value
 *   - _resetControlStateForTests: clears counters and resets state to DISCONNECTED
 *
 * Module-singleton state; tests must call _resetControlStateForTests in
 * beforeEach to avoid cross-test contamination.
 */

import { describe, expect, test, beforeEach } from '@jest/globals';
import {
  transitionBridgeState,
  getBridgeState,
  getRecoveryTelemetry,
  BridgeState,
  _resetControlStateForTests,
} from './control-state';

// Anchor a fixed reference time so test outputs are deterministic.
const T0 = 1_700_000_000_000; // some fixed epoch ms

// ============================================================================
// Lifecycle
// ============================================================================

describe('control-state v1.11: bridge state machine lifecycle', () => {
  beforeEach(() => {
    _resetControlStateForTests();
  });

  test('initial state: DISCONNECTED with all counters at 0', () => {
    expect(getBridgeState()).toBe(BridgeState.DISCONNECTED);
    const r = getRecoveryTelemetry();
    expect(r.reinitializeCount).toBe(0);
    expect(r.disconnectCount).toBe(0);
    expect(r.backoffAttempts).toBe(0);
    expect(r.lastReinitializeAt).toBe(0);
    expect(r.lastDisconnectAt).toBe(0);
    expect(r.lastBackoffAt).toBe(0);
  });

  test('transitionBridgeState: same-state no-op (no counter increment)', () => {
    transitionBridgeState(BridgeState.CONNECTED, 'init', T0);
    const before = getRecoveryTelemetry();
    transitionBridgeState(BridgeState.CONNECTED, 'init-again', T0 + 1000);
    const after = getRecoveryTelemetry();
    expect(after.reinitializeCount).toBe(before.reinitializeCount);
    expect(after.disconnectCount).toBe(before.disconnectCount);
    expect(after.backoffAttempts).toBe(before.backoffAttempts);
    expect(getBridgeState()).toBe(BridgeState.CONNECTED);
  });

  test('transitionBridgeState: DISCONNECTED -> CONNECTED/READY increments reinitializeCount', () => {
    expect(getBridgeState()).toBe(BridgeState.DISCONNECTED);
    transitionBridgeState(BridgeState.CONNECTED, 'first-register', T0 + 5000);
    expect(getRecoveryTelemetry().reinitializeCount).toBe(1);
    expect(getRecoveryTelemetry().lastReinitializeAt).toBe(T0 + 5000);
    expect(getBridgeState()).toBe(BridgeState.CONNECTED);
  });

  test('transitionBridgeState: -> DISCONNECTED increments disconnectCount + updates timestamp', () => {
    transitionBridgeState(BridgeState.CONNECTED, 'init', T0);
    transitionBridgeState(BridgeState.DISCONNECTED, 'extension-gone', T0 + 30_000);
    const r = getRecoveryTelemetry();
    expect(r.disconnectCount).toBe(1);
    expect(r.lastDisconnectAt).toBe(T0 + 30_000);
    expect(getBridgeState()).toBe(BridgeState.DISCONNECTED);
  });

  test('transitionBridgeState: -> BACKOFF increments backoffAttempts + updates timestamp', () => {
    transitionBridgeState(BridgeState.CONNECTED, 'init', T0);
    transitionBridgeState(BridgeState.DISCONNECTED, 'lost', T0 + 1000);
    transitionBridgeState(BridgeState.BACKOFF, 'exhausted', T0 + 2000);
    const r = getRecoveryTelemetry();
    expect(r.backoffAttempts).toBe(1);
    expect(r.lastBackoffAt).toBe(T0 + 2000);
    expect(getBridgeState()).toBe(BridgeState.BACKOFF);
  });

  test('getRecoveryTelemetry returns a snapshot (mutating it does not affect state)', () => {
    transitionBridgeState(BridgeState.CONNECTED, 'init', T0);
    const snap = getRecoveryTelemetry();
    snap.reinitializeCount = 999;
    snap.lastReinitializeAt = 999;
    expect(getRecoveryTelemetry().reinitializeCount).toBe(1);
    expect(getRecoveryTelemetry().lastReinitializeAt).toBe(T0);
  });

  test('_resetControlStateForTests clears counters and resets state to DISCONNECTED', () => {
    transitionBridgeState(BridgeState.CONNECTED, 'init', T0);
    transitionBridgeState(BridgeState.BACKOFF, 'first', T0 + 1000);
    transitionBridgeState(BridgeState.CONNECTED, 'retry-1', T0 + 2000);
    expect(getRecoveryTelemetry().reinitializeCount).toBeGreaterThan(0);
    _resetControlStateForTests();
    expect(getBridgeState()).toBe(BridgeState.DISCONNECTED);
    const r = getRecoveryTelemetry();
    expect(r.reinitializeCount).toBe(0);
    expect(r.disconnectCount).toBe(0);
    expect(r.backoffAttempts).toBe(0);
    expect(r.lastReinitializeAt).toBe(0);
    expect(r.lastDisconnectAt).toBe(0);
    expect(r.lastBackoffAt).toBe(0);
  });
});
