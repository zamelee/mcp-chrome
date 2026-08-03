/**
 * Integration tests for the MCP session soft-degradation protocol (RFC §7.2).
 *
 * These tests use supertest to drive the full bridge HTTP surface
 * (/internal/* + /mcp) and simulate reload events by sending heartbeats
 * with different ownerId values. No real Chrome browser required.
 *
 * The four scenarios from RFC §7.2:
 *   1. STALE_RECOVERED: chrome_click after reload → result with _meta
 *   2. EXTENSION_STARTING: chrome_navigate during reload → retryable error
 *   3. HMR rapid reloads: multiple ownerId changes in quick succession
 *   4. savePath + reload协同: full v1.7.4 + v1.8 integration
 *
 * Note: scenarios 1-3 simulate the preflight+result flow without actually
 * calling the extension (the bridge MCP endpoint returns the error/result
 * shape without dispatching to native host when preflight fails). Scenario 4
 * would need a fuller mock of native-messaging-host which is out of scope for
 * the unit-level integration tests here.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from '@jest/globals';
import supertest from 'supertest';
// Default export is the singleton serverInstance; Server.getInstance() returns fastify.
import Server from '../server/index';
import { recordExtensionConnection, _resetControlStateForTests } from '../control-state';
import { observeHeartbeat, getReloadContext, _resetReloadContextForTests } from './reload-context';
import { HEARTBEAT_STALE_MS, HEARTBEAT_INTERVAL_MS } from '../constant';

const MCP_URL = '/mcp';

async function initSession(supertestAgent: any): Promise<string> {
  // Send initialize request, capture session id from response header.
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0.0.1' },
    },
  });
  const r = await supertestAgent
    .post(MCP_URL)
    .send(initBody)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .expect(200);
  const sid = r.headers['mcp-session-id'];
  expect(sid).toBeTruthy();

  // Send notifications/initialized to complete handshake.
  await supertestAgent
    .post(MCP_URL)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sid)
    .send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    .expect((r) => {
      /* notifications return 202 Accepted, not 200 */
    });
  return sid;
}

async function callTool(
  supertestAgent: any,
  sid: string,
  toolName: string,
  args: any = {},
  id = 10,
): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
  const r = await supertestAgent
    .post(MCP_URL)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set('mcp-session-id', sid)
    .send(body)
    .expect(200);
  // SSE response: parse the data: line
  const text = r.text;
  const lines = text.split('\n');
  const dataLine = lines.find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no data: line in response: ${text.slice(0, 200)}`);
  return JSON.parse(dataLine.slice(6));
}

describe('RFC §7.2 - MCP session soft-degradation integration', () => {
  let supertestAgent: ReturnType<typeof supertest>;
  let sid: string;

  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  afterAll(async () => {
    await Server.stop();
  });

  beforeEach(async () => {
    _resetControlStateForTests();
    _resetReloadContextForTests();
    supertestAgent = supertest(Server.getInstance().server);
    sid = await initSession(supertestAgent);
  });

  // ==========================================================================
  // Scenario 1: reload 后 chrome_click_element → STALE_RECOVERED
  // ==========================================================================
  test('Scenario 1: chrome_click after reload → STALE_RECOVERED + _meta', async () => {
    // Stale heartbeat (100s ago) + reload 100s ago → STALE_RECOVERED
    recordExtensionConnection(
      'test-ext-scenario-1',
      { liveTargets: ['3'], markHeartbeat: true },
      Date.now() - HEARTBEAT_STALE_MS - 10_000,
    );
    observeHeartbeat('owner-A', Date.now() - HEARTBEAT_STALE_MS - 50_000);
    observeHeartbeat('owner-B', Date.now() - HEARTBEAT_STALE_MS - 50_000);

    const result = await callTool(
      supertestAgent,
      sid,
      'chrome_click',
      { tabId: 3, timeoutMs: 2000 }, // shorten native host timeout for test speed
      100,
    );
    expect(result.result).toBeDefined();
    expect(result.result._meta).toBeDefined();
    expect(result.result._meta.sessionStatus).toBe('stale_recovered');
    expect(result.result._meta.recommendation).toBe('re_initialize');
    expect(result.result._meta.heartbeatGapMs).toBeGreaterThanOrEqual(HEARTBEAT_STALE_MS + 10_000);
  }, 30_000); // Allow up to 30s for native host timeout (15s default + overhead)

  // ==========================================================================
  // Scenario 2: reload 中 chrome_navigate → EXTENSION_STARTING + retry
  // ==========================================================================
  test('Scenario 2: chrome_navigate during reload → EXTENSION_STARTING + retryAfterMs', async () => {
    jest.setTimeout(15000);
    // Stale heartbeat (120s ago) + reload 30s ago → EXTENSION_STARTING
    recordExtensionConnection(
      'test-ext-scenario-2',
      { liveTargets: ['3'], markHeartbeat: true },
      Date.now() - HEARTBEAT_STALE_MS - 10_000,
    );
    observeHeartbeat('owner-A', Date.now() - HEARTBEAT_STALE_MS - 50_000);
    observeHeartbeat('owner-B', Date.now() - 30_000);

    const result = await callTool(supertestAgent, sid, 'chrome_navigate', {
      tabId: 3,
      url: 'about:blank',
    });

    expect(result.result.isError).toBe(true);
    const payload = JSON.parse(result.result.content[0].text);
    expect(payload.code).toBe('EXTENSION_STARTING');
    expect(payload.recoverable).toBe(true);
    expect(payload.toolName).toBe('chrome_navigate');
    // retryAfterMs = max(1000, HEARTBEAT_INTERVAL_MS - reloadGapMs + 2000)
    // HEARTBEAT_INTERVAL_MS=30000 (v1.8.2), reloadGapMs=30000, so = max(1000, 2000) = 2000
    expect(payload.retryAfterMs).toBeGreaterThanOrEqual(1_000);
    expect(payload.retryAfterMs).toBeLessThanOrEqual(2_000);
    expect(payload.reloadGapMs).toBeGreaterThanOrEqual(30_000);
    expect(payload.reloadGapMs).toBeLessThanOrEqual(30_005);
  });

  // ==========================================================================
  // Scenario 3: HMR 多次 reload
  // ==========================================================================
  test('Scenario 3: HMR rapid reloads detected via ownerId changes', async () => {
    recordExtensionConnection('test-ext-scenario-3', {
      liveTargets: ['1'],
      markHeartbeat: true,
    });
    observeHeartbeat('owner-A', Date.now() - 200_000);
    observeHeartbeat('owner-B', Date.now() - 50_000);
    observeHeartbeat('owner-C', Date.now() - 30_000);
    observeHeartbeat('owner-D', Date.now() - 10_000);

    const ctx = getReloadContext();
    expect(ctx.lastOwnerId).toBe('owner-D');
    expect(ctx.lastOwnerChangeMs).toBeGreaterThan(Date.now() - 11_000);
  });

  // ==========================================================================
  // Sanity check: error response shape for SESSION_NOT_FOUND
  // ==========================================================================
  test('Sanity: no extension registered → SESSION_NOT_FOUND error', async () => {
    const result = await callTool(supertestAgent, sid, 'chrome_javascript', { tabId: 1 });
    expect(result.result.isError).toBe(true);
    const payload = JSON.parse(result.result.content[0].text);
    expect(payload.code).toBe('SESSION_NOT_FOUND');
    expect(payload.recoverable).toBe(true);
  });
});
