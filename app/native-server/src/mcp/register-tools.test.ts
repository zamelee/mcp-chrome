import { describe, expect, test, beforeEach } from '@jest/globals';
import { runPreflight } from './register-tools';
import { recordExtensionConnection, _resetControlStateForTests } from '../control-state';

describe('Plan 1.4 - tool preflight (runPreflight)', () => {
  beforeEach(() => {
    _resetControlStateForTests();
  });

  test('Safe 工具无 extension 注册时直接放行', () => {
    expect(runPreflight('chrome_history', {})).toBeNull();
    expect(runPreflight('chrome_bookmark_search', { query: 'x' })).toBeNull();
  });

  test('CdpBound 工具无 extension 注册时返回 SESSION_EXPIRED', () => {
    const out = runPreflight('chrome_javascript', { tabId: 7 });
    expect(out).not.toBeNull();
    expect(out?.isError).toBe(true);
    const text = out?.content?.[0]?.text ?? '{}';
    const payload = JSON.parse(text);
    expect(payload.code).toBe('SESSION_EXPIRED');
    expect(payload.recoverable).toBe(true);
    expect(payload.toolName).toBe('chrome_javascript');
  });

  test('CdpBound 工具心跳过期(>90s)返回 SESSION_EXPIRED', () => {
    recordExtensionConnection(
      'test-ext-preflight-stale',
      { liveTargets: ['tgt-1'], markHeartbeat: true },
      Date.now() - 120_000, // 120s old, threshold is 90s (HEARTBEAT_STALE_MS)
    );
    const out = runPreflight('chrome_click', { tabId: 3 });
    expect(out).not.toBeNull();
    const payload = JSON.parse(out!.content[0].text);
    expect(payload.code).toBe('SESSION_EXPIRED');
    expect(payload.message).toMatch(/last heartbeat \d+s ago/);
  });

  test('CdpBound 工具心跳 60s old (典型 heartbeat 间隔) 放行 (regression: 之前 5s 阈值会误判)', () => {
    recordExtensionConnection(
      'test-ext-preflight-between-heartbeats',
      { liveTargets: ['3'], markHeartbeat: true },
      Date.now() - 60_000, // 60s old = exactly 1 heartbeat interval
    );
    expect(runPreflight('chrome_click', { tabId: 3 })).toBeNull();
  });

  test('CdpBound 工具心跳 89s old (1s 内到达阈值) 放行', () => {
    recordExtensionConnection(
      'test-ext-preflight-just-fresh',
      { liveTargets: ['3'], markHeartbeat: true },
      Date.now() - 89_000, // 89s old = just under threshold
    );
    expect(runPreflight('chrome_click', { tabId: 3 })).toBeNull();
  });

  test('CdpBound 工具 targetId 不在 live set 返回 SESSION_EXPIRED', () => {
    recordExtensionConnection('test-ext-preflight-target', {
      liveTargets: ['tgt-live'],
      markHeartbeat: true,
    });
    const out = runPreflight('chrome_javascript', { tabId: 1, targetId: 'tgt-dead' });
    expect(out).not.toBeNull();
    const payload = JSON.parse(out!.content[0].text);
    expect(payload.code).toBe('SESSION_EXPIRED');
    expect(payload.message).toContain('tgt-dead');
    expect(payload.message).toMatch(/not in live set/);
  });

  test('CdpBound 工具 targetId 在 live set + 心跳新鲜 → 放行', () => {
    recordExtensionConnection('test-ext-preflight-ok', {
      liveTargets: ['tgt-a', 'tgt-b', '1'],
      markHeartbeat: true,
    });
    expect(runPreflight('chrome_javascript', { tabId: 1, targetId: 'tgt-a' })).toBeNull();
    expect(runPreflight('chrome_extract', { tabId: 1, targetId: 'tgt-b' })).toBeNull();
  });

  test('CdpBound 工具不传 targetId 时只校验心跳,放行', () => {
    recordExtensionConnection('test-ext-preflight-no-target', {
      liveTargets: ['tgt-a', '1'],
      markHeartbeat: true,
    });
    expect(runPreflight('chrome_javascript', { tabId: 1 })).toBeNull();
  });

  test('TabBound 工具 tabId 不在 live set → SESSION_EXPIRED', () => {
    recordExtensionConnection('test-ext-preflight-tabbound', {
      liveTargets: ['99'],
      markHeartbeat: true,
    });
    const out = runPreflight('chrome_screenshot', { tabId: 1 });
    expect(out).not.toBeNull();
    const payload = JSON.parse(out!.content[0].text);
    expect(payload.code).toBe('SESSION_EXPIRED');
    expect(payload.message).toContain('Tab 1 not in live set');
  });

  test('TabBound 工具 tabId 在 live set → 放行', () => {
    recordExtensionConnection('test-ext-preflight-tabbound-ok', {
      liveTargets: ['1', '2', '3'],
      markHeartbeat: true,
    });
    expect(runPreflight('chrome_screenshot', { tabId: 1 })).toBeNull();
    expect(runPreflight('chrome_navigate', { tabId: 3, url: 'about:blank' })).toBeNull();
  });

  test('CdpBound 工具同时传 targetId 和 tabId 时分别检查', () => {
    recordExtensionConnection('test-ext-preflight-dual', {
      liveTargets: ['42'],
      markHeartbeat: true,
    });
    // targetId 不在 + tabId 在 → 仍失败(targetId 优先)
    const out1 = runPreflight('chrome_javascript', { tabId: 42, targetId: 'tgt-bad' });
    expect(out1).not.toBeNull();
    const p1 = JSON.parse(out1!.content[0].text);
    expect(p1.message).toContain('CDP target tgt-bad');
    // tabId 不在 + 没 targetId → 仍失败(tabId 兜底)
    const out2 = runPreflight('chrome_javascript', { tabId: 99 });
    expect(out2).not.toBeNull();
    const p2 = JSON.parse(out2!.content[0].text);
    expect(p2.message).toContain('Tab 99');
  });

  test('TabBound 工具心跳新鲜 → 放行', () => {
    recordExtensionConnection('test-ext-preflight-tab', {
      liveTargets: ['5'],
      markHeartbeat: true,
    });
    expect(runPreflight('chrome_screenshot', { tabId: 5 })).toBeNull();
    expect(runPreflight('chrome_navigate', { tabId: 5, url: 'about:blank' })).toBeNull();
  });
});
