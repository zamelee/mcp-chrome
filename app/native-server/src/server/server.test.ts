import { describe, expect, test, afterAll, beforeAll } from '@jest/globals';
import supertest from 'supertest';
import Server from './index';
import { getLatestExtensionConnection } from '../control-state';

describe('服务器测试', () => {
  // 启动服务器测试实例
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // 关闭服务器
  afterAll(async () => {
    await Server.stop();
  });

  test('GET /ping 应返回正确响应', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
    });
  });

  test('GET /status 应返回可诊断状态', async () => {
    const response = await supertest(Server.getInstance().server).get('/status').expect(200);

    expect(response.body.server.version).toEqual(expect.any(String));
    expect(response.body.packages).toEqual({
      'mcp-chrome-bridge-2026': response.body.server.version,
    });
    expect(response.body.mcp).toMatchObject({ activeSessions: 0, streamableHttp: true });
    expect(response.body.tools.count).toBeGreaterThan(0);
  });
});

describe('Plan 1.3 - bridge 控制面 /internal/* endpoints', () => {
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  afterAll(async () => {
    await Server.stop();
  });

  test('POST /internal/register 应接受合法 extensionId + liveTargets 并返回 bridgeInstanceId', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/internal/register')
      .send({
        extensionId: 'test-ext-plan13-001',
        version: '1.7.0-plan1.3-test',
        liveTargets: ['target-aaa', 'target-bbb'],
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(typeof response.body.bridgeInstanceId).toBe('string');
    expect(response.body.bridgeInstanceId.length).toBeGreaterThan(0);
    expect(typeof response.body.serverStartedAt).toBe('number');
  });

  test('POST /internal/register 拒绝缺少 extensionId 的 body', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/internal/register')
      .send({ version: '1.0.0', liveTargets: [] })
      .expect(400);

    expect(response.body.error).toBe('INVALID_BODY');
  });

  test('POST /internal/heartbeat 更新已知 extension 的 lastHeartbeat + liveTargets', async () => {
    // 先 register
    await supertest(Server.getInstance().server)
      .post('/internal/register')
      .send({
        extensionId: 'test-ext-plan13-hb',
        version: '1.0.0',
        liveTargets: ['target-old'],
      })
      .expect(200);

    // 再 heartbeat with updated targets
    const hb = await supertest(Server.getInstance().server)
      .post('/internal/heartbeat')
      .send({
        extensionId: 'test-ext-plan13-hb',
        liveTargets: ['target-new-1', 'target-new-2', 'target-new-3'],
      })
      .expect(200);

    expect(hb.body.success).toBe(true);
    expect(hb.body.liveTargetCount).toBe(3);
  });

  test('POST /internal/heartbeat 在未知 extensionId 时返回 reason=unknown_extension', async () => {
    const response = await supertest(Server.getInstance().server)
      .post('/internal/heartbeat')
      .send({
        extensionId: 'test-ext-plan13-never-registered',
        liveTargets: [],
      })
      .expect(200);

    expect(response.body.success).toBe(false);
    expect(response.body.reason).toBe('unknown_extension');
    expect(typeof response.body.bridgeInstanceId).toBe('string');
  });

  test('getLatestExtensionConnection 应返回最新心跳的 connection', async () => {
    // Register two extensions and verify the freshest one wins.
    await supertest(Server.getInstance().server)
      .post('/internal/register')
      .send({ extensionId: 'test-ext-plan13-latest-A', version: '1.0', liveTargets: [] })
      .expect(200);

    await new Promise((r) => setTimeout(r, 5));
    await supertest(Server.getInstance().server)
      .post('/internal/register')
      .send({ extensionId: 'test-ext-plan13-latest-B', version: '1.0', liveTargets: [] })
      .expect(200);

    // Control-state lives in its own module so both server routes and
    // mcp/register-tools.ts can read the same view without import cycles.
    const latest = getLatestExtensionConnection();
    expect(latest).toBeDefined();
    expect(latest?.extensionId).toBe('test-ext-plan13-latest-B');
  });

  test('formatToolError 返回 isError:true + 结构化 code/recoverable/bridgeInstanceId', () => {
    const fakeErr = Object.assign(new Error('boom'), {
      code: 'SESSION_EXPIRED',
      recoverable: true,
      name: 'SessionExpiredError',
    });
    const out = (
      Server as unknown as {
        formatToolError?: (
          err: { code: string; recoverable: boolean },
          toolName: string,
        ) => { isError: true; content: Array<{ type: string; text: string }> };
      }
    ).formatToolError?.(fakeErr, 'chrome_screenshot');
    expect(out).toBeDefined();
    expect(out?.isError).toBe(true);
    const text = out?.content?.[0]?.text ?? '{}';
    const payload = JSON.parse(text);
    expect(payload.code).toBe('SESSION_EXPIRED');
    expect(payload.recoverable).toBe(true);
    expect(payload.toolName).toBe('chrome_screenshot');
    expect(typeof payload.bridgeInstanceId).toBe('string');
  });
});
