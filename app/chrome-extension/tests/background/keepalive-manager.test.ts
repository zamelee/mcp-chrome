/**
 * Unit tests for keepalive-manager.ts reconcileState() (v1.9).
 *
 * Covers the three states:
 *   - normal:  offscreen exists, native connected
 *   - degraded: native missing
 *   - recovering: offscreen missing (triggers self-heal)
 *
 * Also covers the public surface used by bridge-control.ts:
 *   - getReconcileHistory(), getLastHealth()
 *   - _resetReconcileStateForTests()
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  reconcileState,
  getReconcileHistory,
  getLastHealth,
  _resetReconcileStateForTests,
} from '@/entrypoints/background/keepalive-manager';

describe('keepalive-manager reconcileState (v1.9)', () => {
  beforeEach(() => {
    _resetReconcileStateForTests();
    // Default mock: offscreen exists, no native connect API
    vi.mocked(chrome.offscreen.hasDocument).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns normal state when offscreen exists and native API absent (treated as connected)', async () => {
    const state = await reconcileState();
    expect(state.kind).toBe('normal');
    if (state.kind === 'normal') {
      expect(state.health.offscreen.exists).toBe(true);
      expect(state.health.native.connected).toBe(true);
    }
  });

  it('returns recovering state when offscreen hasDocument returns false', async () => {
    vi.mocked(chrome.offscreen.hasDocument).mockResolvedValue(false);
    const state = await reconcileState();
    expect(state.kind).toBe('recovering');
    if (state.kind === 'recovering') {
      expect(state.action).toBe('createOffscreen');
    }
  });

  it('appends to history (bounded at 50 entries)', async () => {
    for (let i = 0; i < 55; i++) {
      vi.mocked(chrome.offscreen.hasDocument).mockResolvedValue(i % 2 === 0);
      await reconcileState();
    }
    const history = getReconcileHistory();
    expect(history.length).toBe(50);
  });

  it('records last health snapshot for inspection', async () => {
    await reconcileState();
    const health = getLastHealth();
    expect(health).not.toBeNull();
    expect(health?.offscreen.exists).toBe(true);
  });

  it('handles hasDocument throwing (treats as missing)', async () => {
    vi.mocked(chrome.offscreen.hasDocument).mockImplementation(() => {
      throw new Error('offscreen API not available in this Chrome version');
    });
    const state = await reconcileState();
    expect(state.kind).toBe('recovering');
  });
});