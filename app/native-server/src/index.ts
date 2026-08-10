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

process.on('uncaughtException', (error: any) => {
  // v1.11.2 hotfix: EPIPE / ECONNRESET on closed native host pipe 是 v1.11.1+ lifecycle
  // 预期副产物. Chrome 关 stdio 后 stdout 仍指向 broken pipe, 下次 sendMessage write
  // 触发 EPIPE. 这种 transient pipe error 不应该把整个 bridge 杀掉.
  // 同样 swallow: ECONNRESET (Win32: 目标方关闭连接), ENOTCONN (socket 未连接),
  // ERR_STREAM_DESTROYED (Node stream 已 destroyed).
  const transientCodes = new Set(['EPIPE', 'ECONNRESET', 'ENOTCONN', 'ERR_STREAM_DESTROYED']);
  if (error && transientCodes.has(error.code)) {
    process.stderr.write(
      '[bridge] suppressed ' + error.code + ': ' + String(error.message) + String.fromCharCode(10),
    );
    return; // 不 exit, 让 bridge 继续 serve HTTP
  }
  process.stderr.write('[bridge] uncaught=' + String(error) + String.fromCharCode(10));
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
});
