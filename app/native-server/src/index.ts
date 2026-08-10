#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  // v1.11.1 hotfix: bind HTTP server at boot BEFORE waiting for START.
  // Reason: Chrome cold-start race closes native host stdio pipe within ~1s
  // of bridge spawn (before extension can post START). Pre-binding 12306
  // makes /health + /internal/register + /mcp reachable immediately.
  // New bridges spawned by Chrome reconnect see EADDRINUSE and exit silently
  // (see native-messaging-host.ts startServer() handler).
  void serverInstance.start(12306, nativeMessagingHostInstance).catch((err) => {
    // EADDRINUSE means another bridge is already serving 12306.
    // Stay alive so this process can still forward directive messages
    // via stdin until Chrome disconnects.
    process.stderr.write(
      `[bridge] boot bind skipped: ${err && err.code ? err.code : String(err)}\n`,
    );
  });
  nativeMessagingHostInstance.start();
} catch (error) {
  process.exit(1);
}

process.on('error', (error) => {
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('exit', (code) => {});

process.on('uncaughtException', (error) => {
  process.stderr.write('[bridge] uncaught=' + String(error) + String.fromCharCode(10));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
});
