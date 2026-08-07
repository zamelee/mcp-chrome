/**
 * v1.10.2: vitest for icon-manager.ts (Chrome toolbar icon state machine).
 *
 * Verifies priority selection, throttle coalescing, sticky-ERROR rule, and
 * clear semantics. We mock chrome.action to capture icon + badge state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAction = {
  setIcon: vi.fn(async () => {}),
  setBadgeText: vi.fn(async () => {}),
  setBadgeBackgroundColor: vi.fn(async () => {}),
};
(globalThis as unknown as { chrome: unknown }).chrome = {
  action: mockAction,
};

import {
  setIconState,
  clearIconState,
  flushIconState,
  _resetForTests,
  _currentStateForTests,
} from '@/entrypoints/background/icon-manager';

describe('icon-manager priority (v1.10.2)', () => {
  beforeEach(() => {
    _resetForTests();
    mockAction.setIcon.mockClear();
    mockAction.setBadgeText.mockClear();
    mockAction.setBadgeBackgroundColor.mockClear();
  });
  afterEach(() => _resetForTests());

  it('READY has lowest priority (1)', async () => {
    setIconState('READY');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setIcon).toHaveBeenCalled());
    const path = mockAction.setIcon.mock.calls[0][0].path;
    expect(path['16']).toContain('/ready/');
  });

  it('ERROR wins over READY when both pending', async () => {
    setIconState('READY');
    setIconState('ERROR');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setIcon).toHaveBeenCalled());
    const path = mockAction.setIcon.mock.calls[0][0].path;
    expect(path['16']).toContain('/error/');
  });

  it('BUSY wins over READY + DISCONNECTED_AUTO', async () => {
    setIconState('READY');
    setIconState('DISCONNECTED_AUTO');
    setIconState('BUSY');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setIcon).toHaveBeenCalled());
    const path = mockAction.setIcon.mock.calls[0][0].path;
    expect(path['16']).toContain('/busy/');
  });

  it('clearIconState removes that state from pending pool', async () => {
    setIconState('READY');
    setIconState('ERROR');
    clearIconState('ERROR');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setIcon).toHaveBeenCalled());
    const path = mockAction.setIcon.mock.calls[0][0].path;
    expect(path['16']).toContain('/ready/');
  });
});

describe('icon-manager badge text + color (v1.10.2)', () => {
  beforeEach(() => {
    _resetForTests();
    mockAction.setIcon.mockClear();
    mockAction.setBadgeText.mockClear();
    mockAction.setBadgeBackgroundColor.mockClear();
  });

  it('READY clears badge text', async () => {
    setIconState('READY');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: '' }));
  });

  it('ERROR sets badge text \"E\" + red bg', async () => {
    setIconState('ERROR');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: 'E' }));
    expect(mockAction.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#dc2626' });
  });

  it('DISCONNECTED_AUTO sets \"...\" badge', async () => {
    setIconState('DISCONNECTED_AUTO');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: '...' }));
  });

  it('BUSY sets \"*\" badge', async () => {
    setIconState('BUSY');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setBadgeText).toHaveBeenCalledWith({ text: '*' }));
  });
});

describe('icon-manager internal state (v1.10.2)', () => {
  beforeEach(() => {
    _resetForTests();
    mockAction.setIcon.mockClear();
  });

  it('starts at null (first applyState initializes)', () => {
    expect(_currentStateForTests()).toBeNull();
  });

  it('updates currentState after apply', async () => {
    setIconState('BUSY');
    flushIconState();
    await vi.waitFor(() => expect(_currentStateForTests()).toBe('BUSY'));
  });

  it('coalesces multiple states in same tick (throttle)', async () => {
    setIconState('READY');
    setIconState('BUSY');
    setIconState('ERROR');
    flushIconState();
    await vi.waitFor(() => expect(mockAction.setIcon).toHaveBeenCalledTimes(1));
    // Only one setIcon call -- the throttle coalesced all 3 state changes.
    const path = mockAction.setIcon.mock.calls[0][0].path;
    expect(path['16']).toContain('/error/');
  });
});