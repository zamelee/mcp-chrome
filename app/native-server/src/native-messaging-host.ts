import { stdin, stdout } from 'process';
import { Server } from './server';
import { v4 as uuidv4 } from 'uuid';
import { NativeMessageType } from '@ethanwilkins/chrome-mcp-shared-2026';
import { TIMEOUTS } from './constant';
import fileHandler from './file-handler';
import { shouldAllowPopup, ShouldAllowPopupInput } from './server/popup-gate';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: NodeJS.Timeout;
}

export interface NativeHostStatus {
  connected: boolean;
  pendingRequests: number;
  lastActivityAt: string | null;
  lastSuccessAt: string | null;
}

export class NativeMessagingHost {
  private associatedServer: Server | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private connected = false;
  private lastActivityAt: Date | null = null;
  private lastSuccessAt: Date | null = null;

  public getStatus(): NativeHostStatus {
    return {
      connected: this.connected,
      pendingRequests: this.pendingRequests.size,
      lastActivityAt: this.lastActivityAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
    };
  }

  /**
   * Gate a browser popup URL against the popup-policy. The Chrome extension
   * background script can call this before deciding whether to allow an OAuth
   * popup to open (e.g. chatgpt.com -> Google SSO -> about:blank -> Google).
   *
   * Returns true iff the popup URL is from a supported SSO provider for the
   * given vendor id, or the popup is an OAuth pre-open about:blank whose
   * opener is a vendor host.
   *
   * Adapted from agentify-sh/desktop popup-policy.mjs (MPL-2.0). See
   * server/popup-gate.ts for the gate implementation and test matrix.
   */
  public evaluatePopupGate(input: ShouldAllowPopupInput): boolean {
    return shouldAllowPopup(input);
  }

  public setServer(serverInstance: Server): void {
    this.associatedServer = serverInstance;
  }

  // add message handler to wait for start server
  public start(): void {
    try {
      this.connected = true;
      this.lastActivityAt = new Date();
      this.setupMessageHandling();
    } catch (error: any) {
      process.exit(1);
    }
  }

  private setupMessageHandling(): void {
    let buffer = Buffer.alloc(0);
    let expectedLength = -1;
    const MAX_MESSAGES_PER_TICK = 100; // Safety guard to avoid long-running loops per readable tick
    const MAX_MESSAGE_SIZE_BYTES = 16 * 1024 * 1024; // 16MB upper bound for a single message

    const processAvailable = () => {
      let processed = 0;
      while (processed < MAX_MESSAGES_PER_TICK) {
        // Read length header when needed
        if (expectedLength === -1) {
          if (buffer.length < 4) break; // not enough for header
          expectedLength = buffer.readUInt32LE(0);
          buffer = buffer.slice(4);

          // Validate length header
          if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE_BYTES) {
            this.sendError(`Invalid message length: ${expectedLength}`);
            // Reset state to resynchronize stream
            expectedLength = -1;
            buffer = Buffer.alloc(0);
            break;
          }
        }

        // Wait for complete body
        if (buffer.length < expectedLength) break;

        const messageBuffer = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;
        processed++;

        try {
          const message = JSON.parse(messageBuffer.toString());
          // CRITICAL: handleMessage is async (it can await startServer etc).
          // Without awaiting, a synchronous sendMessage call inside
          // handleMessage (e.g. the pong_to_extension reply for a ping) can
          // reach stdout before a pending async sendMessage (e.g. the
          // SERVER_STARTED frame) finishes. Chrome native-messaging parser
          // is order-tolerant for individual frames, but the contract should
          // be honest and end-to-end test/debug tooling that watches frames
          // in real time depends on FIFO ordering. Errors are surfaced via
          // sendError(), which writes a structured ERROR_FROM_NATIVE_HOST
          // frame (not stderr) so we do not pollute the protocol stream.
          this.handleMessage(message).catch((err: unknown) => {
            this.sendError(
              `Failed to handle directive message: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        } catch (error: any) {
          this.sendError(`Failed to parse message: ${error.message}`);
        }
      }

      // If we hit the cap but still have at least one complete message pending, schedule to continue soon
      if (processed === MAX_MESSAGES_PER_TICK) {
        setImmediate(processAvailable);
      }
    };

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        buffer = Buffer.concat([buffer, chunk]);
        processAvailable();
      }
    });

    stdin.on('end', () => {
      this.cleanup();
    });

    stdin.on('error', () => {
      this.cleanup();
    });
  }

  private async handleMessage(message: any): Promise<void> {
    this.lastActivityAt = new Date();
    if (!message || typeof message !== 'object') {
      this.sendError('Invalid message format');
      return;
    }

    if (message.responseToRequestId) {
      const requestId = message.responseToRequestId;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.payload);
          this.lastSuccessAt = new Date();
        }
        this.pendingRequests.delete(requestId);
      } else {
        // just ignore
      }
      return;
    }

    // Handle directive messages from Chrome
    try {
      switch (message.type) {
        case NativeMessageType.START:
          await this.startServer(message.payload?.port || 12306);
          break;
        case NativeMessageType.STOP:
          await this.stopServer();
          break;
        case 'FORCE_RESET_SESSIONS':
          // v1.9.6: Popup "Reset Sessions" button — close all MCP transports,
          // forcing clients (e.g. Codex desktop) to re-initialize. Native-host
          // stays alive; only the bridge-side session map is cleared.
          if (this.associatedServer) {
            const result = await this.associatedServer.forceResetSessions();
            this.sendMessage({
              type: 'force_reset_response',
              responseToRequestId: message.requestId,
              payload: result,
            });
          } else {
            this.sendError('No server associated to force-reset sessions');
          }
          break;
        // Keep ping/pong for simple liveness detection, but this differs from request-response pattern
        case 'ping_from_extension':
          this.sendMessage({ type: 'pong_to_extension' });
          break;
        case 'file_operation':
          await this.handleFileOperation(message);
          break;
        default:
          // Double check when message type is not supported
          if (!message.responseToRequestId) {
            this.sendError(
              `Unknown message type or non-response message: ${message.type || 'no type'}`,
            );
          }
      }
    } catch (error: any) {
      this.sendError(`Failed to handle directive message: ${error.message}`);
    }
  }

  /**
   * Handle file operations from the extension
   */
  private async handleFileOperation(message: any): Promise<void> {
    try {
      const result = await fileHandler.handleFileRequest(message.payload);

      if (message.requestId) {
        // Send response back with the request ID
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          payload: result,
        });
      } else {
        // No request ID, just send result
        this.sendMessage({
          type: 'file_operation_result',
          payload: result,
        });
      }
    } catch (error: any) {
      const errorResponse = {
        success: false,
        error: error.message || 'Unknown error during file operation',
      };

      if (message.requestId) {
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          error: errorResponse.error,
        });
      } else {
        this.sendError(`File operation failed: ${errorResponse.error}`);
      }
    }
  }

  /**
   * Send request to Chrome and wait for response
   * @param messagePayload Data to send to Chrome
   * @param timeoutMs Timeout for waiting response (milliseconds)
   * @returns Promise, resolves to Chrome's returned payload on success, rejects on failure
   */
  public sendRequestToExtensionAndWait(
    messagePayload: any,
    messageType: string = 'request_data',
    timeoutMs: number = TIMEOUTS.DEFAULT_REQUEST_TIMEOUT,
    signal?: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4(); // Generate unique request ID

      const cancel = () => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(requestId);
        this.sendMessage({ type: NativeMessageType.CANCEL_TOOL, payload: { requestId } });
        reject(new Error('Request cancelled'));
      };
      if (signal?.aborted) {
        reject(new Error('Request cancelled'));
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId); // Remove from Map after timeout
        signal?.removeEventListener('abort', cancel);
        this.sendMessage({ type: NativeMessageType.CANCEL_TOOL, payload: { requestId } });
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Store request's resolve/reject functions and timeout ID
      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          signal?.removeEventListener('abort', cancel);
          resolve(value);
        },
        reject: (reason) => {
          signal?.removeEventListener('abort', cancel);
          reject(reason);
        },
        timeoutId,
      });

      // Send message with requestId to Chrome
      this.sendMessage({
        type: messageType, // Define a request type, e.g. 'request_data'
        payload: messagePayload,
        requestId: requestId, // <--- Key: include request ID
      });
    });
  }

  /**
   * Start Fastify server (now accepts Server instance)
   */
  private async startServer(port: number): Promise<void> {
    if (!this.associatedServer) {
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      if (this.associatedServer.isRunning) {
        // v1.11.1 hotfix: pre-bound by index.ts at boot. Treat as success
        // instead of error so the extension sees SERVER_STARTED and proceeds
        // to /internal/register + heartbeat without complaining.
        this.sendMessage({
          type: NativeMessageType.SERVER_STARTED,
          payload: { port },
        });
        return;
      }

      await this.associatedServer.start(port, this);

      this.sendMessage({
        type: NativeMessageType.SERVER_STARTED,
        payload: { port },
      });
    } catch (error: any) {
      // If port is already in use (another process started the server), treat as success
      if (error.code === 'EADDRINUSE' || (error.message && error.message.includes('EADDRINUSE'))) {
        this.sendMessage({
          type: NativeMessageType.SERVER_STARTED,
          payload: { port },
        });
        return;
      }
      this.sendError(`Failed to start server: ${error.message}`);
    }
  }

  /**
   * Stop Fastify server
   */
  private async stopServer(): Promise<void> {
    if (!this.associatedServer) {
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      // Check status through associatedServer
      if (!this.associatedServer.isRunning) {
        this.sendMessage({
          type: NativeMessageType.ERROR,
          payload: { message: 'Server is not running' },
        });
        return;
      }

      await this.associatedServer.stop();
      // this.serverStarted = false; // Server should update its own status after successful stop

      this.sendMessage({ type: NativeMessageType.SERVER_STOPPED }); // Distinguish from previous 'stopped'
    } catch (error: any) {
      this.sendError(`Failed to stop server: ${error.message}`);
    }
  }

  /**
   * Send message to Chrome extension
   */
  public sendMessage(message: any): void {
    try {
      const messageString = JSON.stringify(message);
      const messageBuffer = Buffer.from(messageString);
      const headerBuffer = Buffer.alloc(4);
      headerBuffer.writeUInt32LE(messageBuffer.length, 0);
      // Ensure atomic write
      stdout.write(Buffer.concat([headerBuffer, messageBuffer]), (err) => {
        if (err) {
          // Consider how to handle write failure, may affect request completion
        } else {
          // Message sent successfully, no action needed
        }
      });
    } catch (error: any) {
      // Catch JSON.stringify or Buffer operation errors
      // If preparation stage fails, associated request may never be sent
      // Need to consider whether to reject corresponding Promise (if called within sendRequestToExtensionAndWait)
    }
  }

  /**
   * Send error message to Chrome extension (mainly for sending non-request-response type errors)
   */
  private sendError(errorMessage: string): void {
    // IMPORTANT: do NOT log this to console / stderr here. The native-messaging
    // host child uses stdout strictly for length-prefixed JSON frames; even
    // after fixing the upstream console.log bugs in server/index.ts and
    // cleanup(), adding noisy stderr writes here would still be wrong because
    // sendError is reachable from the protocol handler itself (e.g. invalid
    // JSON, oversized frame), and corrupting the byte stream mid-frame can
    // tear down Chrome's host child. Use the structured ERROR_FROM_NATIVE_HOST
    // message type so the extension's background handler decides what to do.
    this.sendMessage({
      type: NativeMessageType.ERROR_FROM_NATIVE_HOST,
      payload: { message: errorMessage },
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.connected = false;
    // Reject all pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Native host is shutting down or Chrome disconnected.'));
    });
    this.pendingRequests.clear();
    // CRITICAL: do NOT use console.log here. The native-messaging host child
    // uses stdout for length-prefixed JSON frames only; any plain text written
    // to stdout corrupts the protocol stream and triggers Chrome to close the
    // host child prematurely on the next connectNative retry. stderr is
    // captured by run_host.bat to native_host_stderr_*.log.
    process.stderr.write('[native-messaging-host] Connection closed; staying alive for HTTP.\n');

    // v1.11.1 hotfix (REPLACES REVERTED Plan Y): keep the bridge process alive
    // after Chrome closes the native host stdio pipe. The HTTP server stays
    // bound on 12306 (started at boot via index.ts) so existing Codex MCP
    // sessions + the extension heartbeat loop continue working.
    //
    // Why this is safe now (vs the orphan trap the old Plan Y comment warned about):
    // 1. Chrome connects native host by spawning a fresh host child process;
    //    that child is THIS process. When Chrome closes the pipe, this process
    //    has nothing useful left to do via stdin (read loop exits).
    // 2. But the HTTP server bound at boot (index.ts) keeps 12306 reachable.
    // 3. New Chrome connectNative attempts spawn NEW bridge processes; their
    //    startServer() tries to bind 12306 -> EADDRINUSE -> treated as success
    //    (see startServer() patch below) -> new extension session sees
    //    SERVER_STARTED; HTTP traffic routes to the original bridge.
    // 4. Manual shutdown paths still work: STOP message from extension ->
    //    stopServer() + process.exit(0); SIGINT/SIGTERM -> index.ts handlers.
    // 5. Orphan cleanup: userland Stop-Process / taskkill (documented in AGENTS.md).
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
