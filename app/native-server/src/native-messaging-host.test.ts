/**
 * Unit tests for native-messaging-host.ts (v1.11.1 hotfix: lifecycle behavior).
 *
 * Covers:
 *   - cleanup() does NOT call process.exit (v1.11.1 REPLACES REVERTED Plan Y)
 *   - cleanup() logs the new "staying alive for HTTP" message
 *   - cleanup() does not stop the associated server
 *   - startServer() sends SERVER_STARTED (not ERROR) when server already running
 *   - startServer() sends SERVER_STARTED on EADDRINUSE
 *
 * Module-singleton state via NativeMessagingHost instance.
 * Tests use process.exit spy to verify exit is not called.
 */

import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import NativeMessagingHost from './native-messaging-host';

// Helper to access private members for testing
type NativeHostPrivate = {
  cleanup: () => void;
  startServer: (port: number) => Promise<void>;
  sendMessage: (msg: unknown) => void;
  sendError: (msg: string) => void;
  associatedServer: unknown;
  connected: boolean;
};

describe('native-messaging-host v1.11.1 lifecycle: cleanup does not exit', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>;
  let stderrWrites: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    // Spy on process.exit to ensure cleanup() does NOT call it
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was unexpectedly called`);
    }) as never);

    // Capture stderr writes
    stderrWrites = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      if (typeof chunk === 'string') {
        stderrWrites.push(chunk);
      }
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.stderr.write = originalStderrWrite;
  });

  test('cleanup() does not call process.exit', () => {
    const host = NativeMessagingHost as unknown as NativeHostPrivate;
    expect(() => host.cleanup()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('cleanup() logs the new "staying alive for HTTP" message', () => {
    const host = NativeMessagingHost as unknown as NativeHostPrivate;
    host.cleanup();
    const allLogs = stderrWrites.join('');
    expect(allLogs).toContain('Connection closed; staying alive for HTTP');
    // Ensure OLD log message is NOT emitted
    expect(allLogs).not.toContain('Connection closed; bridge shutting down');
  });

  test('cleanup() does not stop the associated server (no server.stop call)', () => {
    const stopSpy = jest.fn();
    const fakeServer = {
      isRunning: true,
      stop: stopSpy,
    };
    const host = NativeMessagingHost as unknown as NativeHostPrivate;
    host.associatedServer = fakeServer;

    host.cleanup();
    // cleanup() must NOT have called server.stop()
    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe('native-messaging-host v1.11.1 lifecycle: startServer pre-bound returns SERVER_STARTED', () => {
  let sentMessages: unknown[];
  let stderrWrites: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    sentMessages = [];
    stderrWrites = [];

    const host = NativeMessagingHost as unknown as NativeHostPrivate;
    host.sendMessage = (msg: unknown) => {
      sentMessages.push(msg);
    };
    host.sendError = (msg: string) => {
      sentMessages.push({ type: 'ERROR', payload: { message: msg } });
    };

    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      if (typeof chunk === 'string') {
        stderrWrites.push(chunk);
      }
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
  });

  test('startServer() when server already running sends SERVER_STARTED (not ERROR)', async () => {
    const fakeServer = { isRunning: true, start: jest.fn() };
    const host = NativeMessagingHost as unknown as NativeHostPrivate;
    host.associatedServer = fakeServer;

    await host.startServer(12306);

    // Find the SERVER_STARTED frame (NativeMessageType.SERVER_STARTED is 'server_started' lowercase)
    const started = sentMessages.find(
      (m): m is { type: string; payload: { port: number } } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'server_started',
    );
    expect(started).toBeDefined();
    expect(started!.payload.port).toBe(12306);

    // Ensure we did NOT send an ERROR frame
    const errorFrames = sentMessages.filter(
      (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'ERROR',
    );
    expect(errorFrames).toHaveLength(0);

    // Ensure we did NOT call fakeServer.start() (already running)
    expect((fakeServer.start as jest.Mock).mock.calls).toHaveLength(0);
  });

  test('startServer() on EADDRINUSE sends SERVER_STARTED (treat as success)', async () => {
    const eaddrError: Error & { code?: string } = new Error(
      'listen EADDRINUSE: address already in use',
    );
    eaddrError.code = 'EADDRINUSE';
    const fakeServer = {
      isRunning: false,
      start: jest.fn(async () => {
        throw eaddrError;
      }),
    };
    const host = NativeMessagingHost as unknown as NativeHostPrivate;
    host.associatedServer = fakeServer;

    await host.startServer(12306);

    // Find the SERVER_STARTED frame (lowercase enum value)
    const started = sentMessages.find(
      (m): m is { type: string; payload: { port: number } } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'server_started',
    );
    expect(started).toBeDefined();
    expect(started!.payload.port).toBe(12306);

    // Ensure we did NOT send an ERROR frame
    const errorFrames = sentMessages.filter(
      (m) => typeof m === 'object' && m !== null && (m as { type?: string }).type === 'ERROR',
    );
    expect(errorFrames).toHaveLength(0);
  });
});
