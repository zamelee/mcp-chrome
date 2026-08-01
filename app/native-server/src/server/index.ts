/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getMcpServer } from '../mcp/mcp-server';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { DeepSeekEngine } from '../agent/engines/deepseek';
import { closeDb } from '../agent/db';
import { registerAgentRoutes } from './routes';
import { TOOL_SCHEMAS } from '@ethanwilkins/chrome-mcp-shared-2026';
import packageJson from '../../package.json';
import { getRecentToolCalls } from '../mcp/register-tools';
import { NativeMessageType } from '@ethanwilkins/chrome-mcp-shared-2026';
import { randomUUID as _randUuid } from 'node:crypto';
import {
  SessionExpiredError,
  TabGoneError,
  assertRuntime,
  assertTab,
  assertTarget,
  safetyLevelFor,
  SafetyLevel,
} from '../tool-safety';
import {
  recordExtensionConnection,
  getExtensionConnection,
  getLatestExtensionConnection,
} from '../control-state';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

type McpTransport = StreamableHTTPServerTransport | SSEServerTransport;
interface McpSession {
  transport: McpTransport;
  createdAt: Date;
  lastActivityAt: Date;
  activeRequests: number;
  lastError: string | null;
}
const SESSION_TTL_MS = 24 * 60 * 60_000; // 24h, idle session reclaimed; clients can re-init seamlessly (initialize accepted with stale sid)

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  private nativeHost: NativeMessagingHost | null = null;
  private transportsMap = new Map<string, McpSession>();
  private startedAt = Date.now();
  // Plan 1.1 + 2.x: bridge identity + extension heartbeat tracking
  private bridgeInstanceId: string = randomUUID();
  private reclaimedSessions = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

  constructor() {
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine(), new DeepSeekEngine()],
      streamManager: this.agentStreamManager,
    });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private async setupPlugins(): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        // Check if origin matches any pattern in whitelist
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
        );
        cb(null, allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // MCP routes
    this.setupMcpRoutes();

    // Plan 1.3: bridge <-> extension control plane (register / heartbeat / error format).
    // Separate from /mcp so that lifecycle signals don't pollute MCP tool traffic.
    this.setupInternalRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================
  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });

    // Plan 2.4: GET /health — diagnostic surface for "is the bridge alive and
    // talking to a live extension?". Returns bridgeInstanceId (Plan 1.1),
    // uptime, and the most recent extension connection snapshot. Clients
    // (CLI, dashboard, CodeX mcp__mcp_chrome tool) can poll this to detect
    // reload-staleness without going through the full MCP initialize flow.
    this.fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const conn = getLatestExtensionConnection();
        const heartbeatAgeMs = conn ? Date.now() - conn.lastHeartbeat : null;
        const liveTargetCount = conn ? conn.liveTargets.size : 0;
        reply.status(HTTP_STATUS.OK).send({
          status: 'ok',
          bridgeInstanceId: this.bridgeInstanceId,
          serverStartedAt: this.startedAt,
          uptimeMs: Date.now() - this.startedAt,
          extension: conn
            ? {
                extensionId: conn.extensionId,
                version: conn.version,
                connectedAt: conn.connectedAt,
                lastHeartbeat: conn.lastHeartbeat,
                heartbeatAgeMs,
                liveTargetCount,
              }
            : null,
        });
      } catch (err) {
        console.error('[bridge] /health handler failed:', err);
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    this.fastify.get(
      '/status',
      async (request: FastifyRequest<{ Querystring: { probe?: string } }>, reply: FastifyReply) => {
        const sessions = [...this.transportsMap.values()];
        let probe: Record<string, unknown> | undefined;
        if (request.query.probe === '1') {
          const startedAt = Date.now();
          try {
            const response = await this.nativeHost?.sendRequestToExtensionAndWait(
              { name: 'chrome_get_tab_url', args: {} },
              NativeMessageType.CALL_TOOL,
              3_000,
            );
            probe = { ok: response?.status === 'success', elapsedMs: Date.now() - startedAt };
          } catch (error) {
            probe = { ok: false, elapsedMs: Date.now() - startedAt, error: String(error) };
          }
        }
        return reply.status(HTTP_STATUS.OK).send({
          server: { version: packageJson.version, uptimeMs: Date.now() - this.startedAt },
          packages: {
            'mcp-chrome-bridge-2026': packageJson.version,
          },
          mcp: {
            activeSessions: sessions.length,
            activeRequests: sessions.reduce((total, session) => total + session.activeRequests, 0),
            reclaimedSessions: this.reclaimedSessions,
            streamableHttp: true,
          },
          extension: this.nativeHost?.getStatus() ?? null,
          nativeHost: this.nativeHost?.getStatus() ?? null,
          tools: { count: TOOL_SCHEMAS.length },
          recentToolCalls: getRecentToolCalls(),
          ...(probe ? { probe } : {}),
        });
      },
    );
  }

  private addSession(sessionId: string, transport: McpTransport): void {
    this.transportsMap.set(sessionId, {
      transport,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      activeRequests: 0,
      lastError: null,
    });
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, session] of this.transportsMap) {
      if (session.activeRequests || now - session.lastActivityAt.getTime() < SESSION_TTL_MS)
        continue;
      this.transportsMap.delete(sessionId);
      this.reclaimedSessions++;
      await session.transport.close().catch(() => undefined);
    }
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const transport = new SSEServerTransport('/messages', reply.raw);
        this.addSession(transport.sessionId, transport);

        reply.raw.on('close', () => {
          this.transportsMap.delete(transport.sessionId);
        });

        const server = getMcpServer();
        await server.connect(transport);

        reply.raw.write(':\n\n');
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      try {
        const { sessionId } = req.query as { sessionId?: string };
        const session = this.transportsMap.get(sessionId || '');
        const transport = session?.transport as SSEServerTransport | undefined;
        if (!sessionId || !session || !transport) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }

        session.lastActivityAt = new Date();
        session.activeRequests++;
        try {
          await transport.handlePostMessage(req.raw, reply.raw, req.body);
        } finally {
          session.activeRequests--;
        }
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let session = this.transportsMap.get(sessionId || '');
      let transport: StreamableHTTPServerTransport | undefined = session?.transport as
        StreamableHTTPServerTransport | undefined;

      if (transport) {
        // Transport found, proceed
      } else if (isInitializeRequest(request.body)) {
        // Accept initialize even when sessionId is stale or missing — lets clients
        // recover from a TTL-driven reclaim without manual coordination.
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (initializedSessionId) => {
            if (transport && initializedSessionId === newSessionId) {
              this.addSession(initializedSessionId, transport);
            }
          },
        });

        transport.onclose = () => {
          if (transport?.sessionId && this.transportsMap.get(transport.sessionId)) {
            this.transportsMap.delete(transport.sessionId);
          }
        };
        await getMcpServer().connect(transport);
      } else {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
        return;
      }

      session = this.transportsMap.get(transport.sessionId || sessionId || '');
      if (session) {
        session.lastActivityAt = new Date();
        session.activeRequests++;
      }
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        if (session) session.lastError = error instanceof Error ? error.message : String(error);
        if (!reply.sent) {
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR });
        }
      } finally {
        if (session) session.activeRequests--;
      }
    });

    // MCP GET endpoint (SSE stream)
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? this.transportsMap.get(sessionId) : undefined;
      const transport = session?.transport as StreamableHTTPServerTransport | undefined;

      if (!transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
        return;
      }

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.hijack();
        }
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // MCP DELETE endpoint
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? this.transportsMap.get(sessionId) : undefined;
      const transport = session?.transport as StreamableHTTPServerTransport | undefined;

      if (!transport) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.code(HTTP_STATUS.NO_CONTENT).send();
        }
      } catch (error) {
        if (!reply.sent) {
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR });
        }
      }
    });
  }

  // ============================================================
  // Internal Control Routes (Plan 1.3)
  // ============================================================
  //
  // Lightweight control plane between the Chrome extension and the bridge. These
  // endpoints let the extension publish its CDP target snapshot to the bridge so
  // that the tool preflight (Plan 1.4) can detect "extension reloaded" without
  // silently corrupting ongoing tool calls.
  //
  // Wire shape:
  //   extension -> POST /internal/register     { extensionId, version, liveTargets }
  //   extension -> POST /internal/heartbeat    { extensionId, liveTargets }   (every ~60s)
  //
  // Both endpoints reply with the current `bridgeInstanceId` so the extension
  // can detect that the bridge was restarted (e.g. after a reload of the
  // extension itself caused the bridge to exit).

  private setupInternalRoutes(): void {
    type RegisterBody = {
      extensionId?: unknown;
      version?: unknown;
      liveTargets?: unknown;
    };

    this.fastify.post('/internal/register', async (request, reply) => {
      const body = (request.body ?? {}) as RegisterBody;
      const extensionId = typeof body.extensionId === 'string' ? body.extensionId : '';
      const version = typeof body.version === 'string' ? body.version : 'unknown';
      const liveTargets = Array.isArray(body.liveTargets)
        ? body.liveTargets.filter((t): t is string => typeof t === 'string')
        : [];

      if (!extensionId) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({
          error: 'INVALID_BODY',
          message: 'extensionId (string) is required',
        });
        return;
      }

      const conn = recordExtensionConnection(extensionId, {
        version,
        liveTargets,
        markHeartbeat: true,
      });
      console.log(
        `[bridge] extension registered: id=${extensionId} version=${version} ` +
          `targets=${conn.liveTargets.size} epoch=${this.bridgeInstanceId}`,
      );
      reply.code(HTTP_STATUS.OK).send({
        success: true,
        bridgeInstanceId: this.bridgeInstanceId,
        serverStartedAt: this.startedAt,
      });
    });

    type HeartbeatBody = {
      extensionId?: unknown;
      liveTargets?: unknown;
    };

    this.fastify.post('/internal/heartbeat', async (request, reply) => {
      const body = (request.body ?? {}) as HeartbeatBody;
      const extensionId = typeof body.extensionId === 'string' ? body.extensionId : '';
      const liveTargets = Array.isArray(body.liveTargets)
        ? body.liveTargets.filter((t): t is string => typeof t === 'string')
        : [];

      if (!extensionId) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({
          error: 'INVALID_BODY',
          message: 'extensionId (string) is required',
        });
        return;
      }

      const existing = getExtensionConnection(extensionId);
      if (!existing) {
        // Heartbeat arrived before the extension ever called /internal/register.
        // Tell it to re-register so we can attach a fresh heartbeat window.
        reply.code(HTTP_STATUS.OK).send({
          success: false,
          reason: 'unknown_extension',
          bridgeInstanceId: this.bridgeInstanceId,
        });
        return;
      }

      const conn = recordExtensionConnection(extensionId, {
        version: existing.version,
        liveTargets,
        markHeartbeat: true,
      });
      reply.code(HTTP_STATUS.OK).send({
        success: true,
        bridgeInstanceId: this.bridgeInstanceId,
        serverStartedAt: this.startedAt,
        liveTargetCount: conn.liveTargets.size,
      });
    });
  }

  /**
   * Public helper for Plan 1.4 (tool preflight error formatting). Produces the
   * MCP tool-result envelope that signals "your CDP/tab binding is gone; the
   * extension was reloaded" so the client re-initializes instead of retrying.
   *
   * Wire format is intentionally JSON-in-text (not HTTP 400) so existing MCP
   * clients that don't yet know the error code still surface a useful message
   * to the LLM. The structured `{code, recoverable, message}` lets newer
   * clients switch on the code and skip retries.
   */
  public formatToolError(
    err: SessionExpiredError | TabGoneError,
    toolName: string,
  ): { isError: true; content: Array<{ type: 'text'; text: string }> } {
    const payload = {
      code: err.code,
      recoverable: err.recoverable,
      toolName,
      message: err.message,
      bridgeInstanceId: this.bridgeInstanceId,
    };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    };
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    // Plan 1.1: re-roll bridge epoch per process start. Clients use this to detect
    // that the bridge was restarted (e.g. after extension reload).
    this.bridgeInstanceId = randomUUID();
    // CRITICAL: native-messaging host child uses stdout for length-prefixed JSON
    // frames only. console.log writes to stdout and corrupts the protocol stream
    // (Chrome reads the leading bytes as a length header, sees an invalid value,
    // and tears down the host child immediately). Always use stderr here, and
    // mirror this pattern for any other logs reachable from server.start().
    process.stderr.write(`[bridge] new epoch: ${this.bridgeInstanceId}\n`);
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      this.isRunning = true;
      this.startedAt = Date.now();
      this.cleanupTimer = setInterval(() => void this.cleanupStaleSessions(), 60_000);
      this.cleanupTimer.unref();
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      await this.fastify.close();
      closeDb();
      this.isRunning = false;
    } catch (err) {
      this.isRunning = false;
      closeDb();
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
