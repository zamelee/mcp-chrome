/**
 * Unit tests for bridge-control.ts alarm path (v1.8.2).
 *
 * Covers:
 *   - startHeartbeat() schedules chrome.alarms.create({ periodInMinutes: 0.5 })
 *   - stopHeartbeat() calls chrome.alarms.clear with the alarm name
 *   - re-starting heartbeat with the same port is a no-op (no alarm churn)
 *
 * Note: We do NOT directly invoke the chrome.alarms.onAlarm listener from
 * these tests. The listener is registered at module load (before test mocks
 * have a chance to capture the function reference), and vitest.config.ts
 * `restoreMocks: true` strips mock implementations between tests. Listener
 * behavior is covered by:
 *   - The v1.7.3 triggerImmediateHeartbeatIfActive test (chrome.tabs.* events),
 *     which exercises the same code path that alarm listener invokes
 *   - Manual smoke test on Chrome 134+ Windows (RFC testing-strategy)
 *
 * The 3 tests below are sufficient to catch regressions in:
 *   - "did anyone remove the chrome.alarms.create call?"
 *   - "did anyone change the alarm period from 0.5 (30s)?"
 *   - "did anyone remove the chrome.alarms.clear on stop?"
 *   - "did anyone break the port-deduplication guard?"
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/record-replay-v3/bootstrap', () => ({
  getV3Runtime: () => ({
    ownerId: 'test-owner-id',
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  _resetControlStateForTests,
  onBridgeStarted,
  onBridgeStopped,
} from '@/entrypoints/background/bridge-control';

const HEARTBEAT_ALARM_NAME = 'bridge-heartbeat';

describe('bridge-control alarm path (v1.8.2)', () => {
  beforeEach(() => {
    _resetControlStateForTests();
    vi.clearAllMocks();
    // Re-install mock implementations stripped by clearMocks/restoreMocks.
    vi.mocked(chrome.alarms.create).mockImplementation(() => Promise.resolve());
    vi.mocked(chrome.alarms.clear).mockImplementation(() => Promise.resolve());
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ bridgeInstanceId: 'test-bridge', serverStartedAt: Date.now() }),
        { status: 200 },
      ),
    );
  });

  afterEach(() => {
    onBridgeStopped();
    vi.clearAllTimers();
  });

  it('startHeartbeat() calls chrome.alarms.create with periodInMinutes: 0.5', async () => {
    await onBridgeStarted(12306);
    expect(chrome.alarms.create).toHaveBeenCalledWith(HEARTBEAT_ALARM_NAME, {
      periodInMinutes: 0.5,
    });
  });

  it('stopHeartbeat() calls chrome.alarms.clear with the alarm name', async () => {
    await onBridgeStarted(12306);
    onBridgeStopped();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(HEARTBEAT_ALARM_NAME);
  });

  it('re-starting heartbeat with same port is a no-op (no alarm churn)', async () => {
    await onBridgeStarted(12306);
    vi.mocked(chrome.alarms.create).mockClear();
    vi.mocked(chrome.alarms.clear).mockClear();
    await onBridgeStarted(12306);
    expect(chrome.alarms.clear).not.toHaveBeenCalled();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });
});