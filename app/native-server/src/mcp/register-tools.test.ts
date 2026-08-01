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

  test('CdpBound 工具心跳过期(>5s)返回 SESSION_EXPIRED', () => {
    recordExtensionConnection(
      'test-ext-preflight-stale',
      { liveTargets: ['tgt-1'], markHeartbeat: true },
      Date.now() - 10_000, // 10s old, threshold is 5s
    );
    const out = runPreflight('chrome_click', { tabId: 3 });
    expect(out).not.toBeNull();
    const payload = JSON.parse(out!.content[0].text);
    expect(payload.code).toBe('SESSION_EXPIRED');
    expect(payload.message).toMatch(/last heartbeat \d+s ago/);
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
      liveTargets: ['tgt-a', 'tgt-b'],
      markHeartbeat: true,
    });
    expect(runPreflight('chrome_javascript', { tabId: 1, targetId: 'tgt-a' })).toBeNull();
    expect(runPreflight('chrome_extract', { tabId: 1, targetId: 'tgt-b' })).toBeNull();
  });

  test('CdpBound 工具不传 targetId 时只校验心跳,放行', () => {
    recordExtensionConnection('test-ext-preflight-no-target', {
      liveTargets: ['tgt-a'],
      markHeartbeat: true,
    });
    expect(runPreflight('chrome_javascript', { tabId: 1 })).toBeNull();
  });

  test('TabBound 工具心跳新鲜 → 放行', () => {
    recordExtensionConnection('test-ext-preflight-tab', { liveTargets: [], markHeartbeat: true });
    expect(runPreflight('chrome_screenshot', { tabId: 5 })).toBeNull();
    expect(runPreflight('chrome_navigate', { tabId: 5, url: 'about:blank' })).toBeNull();
  });
});
