/**
 * v1.10.1: vitest for monitor.ts (popup double-work communication monitor).
 *
 * The monitor module owns an in-memory ring buffer + chrome.storage.session
 * persistence. We test the pure-logic helpers (safeSummary, classifySeverity,
 * aggregate, ring-buffer eviction, subscribe/unsubscribe) without touching
 * chrome.storage APIs (which are unavailable in vitest's jsdom env).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock chrome.storage.session for the tests that need it
const mockStorage: { session: Record<string, unknown> } = { session: {} };
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: mockStorage.session[key] })),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(mockStorage.session, obj);
      }),
      remove: vi.fn(async (key: string) => {
        delete mockStorage.session[key];
      }),
    },
  },
};

import {
  recordMessage,
  snapshot,
  subscribe,
  hydrateFromStorage,
  clear,
  aggregate,
  safeSummary,
  classifySeverity,
  MAX_BUFFER_SIZE,
} from '@/entrypoints/background/monitor';

describe('safeSummary (v1.10.1)', () => {
  it('truncates to 80 chars', () => {
    const long = 'x'.repeat(200);
    const s = safeSummary({ a: long });
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith('...')).toBe(true);
  });

  it('redacts sensitive keys', () => {
    const s = safeSummary({ token: 'eyJabc', cookie: 'session=xyz', name: 'foo' });
    expect(s).toContain('<redacted>');
    expect(s).not.toContain('eyJabc');
    expect(s).not.toContain('session=xyz');
    expect(s).toContain('foo');
  });

  it('handles primitives', () => {
    expect(safeSummary('hello')).toBe('"hello"');
    expect(safeSummary(42)).toBe('42');
    expect(safeSummary(null)).toBe('');
    expect(safeSummary(undefined)).toBe('');
  });

  it('handles arrays', () => {
    expect(safeSummary([1, 2, 3])).toBe('[1,2,3]');
  });
});

describe('classifySeverity (v1.10.1)', () => {
  it('flags error types', () => {
    expect(classifySeverity('error_from_native_host', null)).toBe('error');
    expect(classifySeverity('tool_fail', null)).toBe('error');
    expect(classifySeverity('invalid_request', null)).toBe('error');
  });
  it('flags payload with error field', () => {
    expect(classifySeverity('call_tool', { error: 'oops' })).toBe('error');
    expect(classifySeverity('call_tool', { status: 'error' })).toBe('error');
  });
  it('defaults to info', () => {
    expect(classifySeverity('started', null)).toBe('info');
    expect(classifySeverity('call_tool', { ok: true })).toBe('info');
  });
});

describe('recordMessage + ring buffer (v1.10.1)', () => {
  beforeEach(() => {
    mockStorage.session = {};
    // Clear in-memory buffer by calling clear()
    void clear();
  });
  afterEach(() => {
    void clear();
  });

  it('appends events with monotonic ids', () => {
    const e1 = recordMessage({ layer: 'popup', direction: 'in', type: 't1' });
    const e2 = recordMessage({ layer: 'native', direction: 'in', type: 't2' });
    expect(e2.id).toBeGreaterThan(e1.id);
    const snap = snapshot();
    expect(snap.length).toBe(2);
    expect(snap[snap.length - 1].id).toBe(e2.id);
  });

  it('evicts oldest when buffer exceeds MAX_BUFFER_SIZE', () => {
    for (let i = 0; i < MAX_BUFFER_SIZE + 5; i++) {
      recordMessage({ layer: 'popup', direction: 'in', type: `t${i}` });
    }
    const snap = snapshot();
    expect(snap.length).toBe(MAX_BUFFER_SIZE);
    // First should now be t5 (we evicted t0..t4)
    expect(snap[0].type).toBe('t5');
  });

  it('subscribers receive live updates', () => {
    const updates: number[] = [];
    const unsub = subscribe((events) => updates.push(events.length));
    recordMessage({ layer: 'popup', direction: 'in', type: 'live1' });
    recordMessage({ layer: 'popup', direction: 'in', type: 'live2' });
    expect(updates).toContain(1);
    expect(updates).toContain(2);
    unsub();
    recordMessage({ layer: 'popup', direction: 'in', type: 'live3' });
    expect(updates[updates.length - 1]).toBe(2);
  });

  it('persists to chrome.storage.session (debounced 500ms)', async () => {
    recordMessage({ layer: 'popup', direction: 'in', type: 'persist1' });
    // Before debounce fires, storage not yet written
    expect(Object.keys(mockStorage.session)).toHaveLength(0);
    // Wait for debounce
    await new Promise((r) => setTimeout(r, 600));
    expect(mockStorage.session['messageBuffer']).toBeDefined();
    const persisted = mockStorage.session['messageBuffer'] as unknown[];
    expect(persisted.length).toBeGreaterThan(0);
  });

  it('hydrateFromStorage restores persisted buffer', async () => {
    recordMessage({ layer: 'popup', direction: 'in', type: 'hydrate-test' });
    await new Promise((r) => setTimeout(r, 600));
    expect(mockStorage.session['messageBuffer']).toBeDefined();
    // Force in-memory buffer overflow to wipe it (without touching storage).
    for (let i = 0; i < MAX_BUFFER_SIZE + 5; i++) {
      recordMessage({ layer: 'native', direction: 'in', type: `filler${i}` });
    }
    expect(snapshot().some((e) => e.type === 'hydrate-test')).toBe(false);
    // Now hydrate from storage should restore the original message.
    await hydrateFromStorage();
    const snap = snapshot();
    expect(snap.some((e) => e.type === 'hydrate-test')).toBe(true);
  });

  it('clear() empties both buffer and storage', async () => {
    recordMessage({ layer: 'popup', direction: 'in', type: 'clear-test' });
    await new Promise((r) => setTimeout(r, 600));
    await clear();
    expect(snapshot().length).toBe(0);
    expect(mockStorage.session['messageBuffer']).toBeUndefined();
  });
});

describe('aggregate (v1.10.1)', () => {
  beforeEach(() => void clear());

  it('counts by direction, layer, severity', () => {
    recordMessage({ layer: 'popup', direction: 'in', type: 'a' });
    recordMessage({ layer: 'native', direction: 'in', type: 'b' });
    recordMessage({ layer: 'background', direction: 'out', type: 'c' });
    recordMessage({ layer: 'background', direction: 'out', type: 'error_from_native' });
    const a = aggregate(snapshot());
    expect(a.total).toBe(4);
    expect(a.in).toBe(2);
    expect(a.out).toBe(2);
    expect(a.byLayer.popup).toBe(1);
    expect(a.byLayer.native).toBe(1);
    expect(a.byLayer.background).toBe(2);
    expect(a.errors).toBe(1);
  });
});