#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { NATIVE_SERVER_PORT } from './constant';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  // Plan Z (reload-fix close-the-loop, take 2): pre-start the HTTP server
  // synchronously so the bridge's event loop has something to keep alive
  // even before Chrome sends its first START message. Without this, when
  // Chrome spawns the host child and immediately closes stdin (extension
  // reload path), the bridge's event loop drains and the process exits
  // with code 0 — silently taking the reload-fix down with it.
  //
  // We pass `nativeMessagingHostInstance` so server.start() can send back
  // SERVER_STARTED on success via the native port (if connected). The
  // listen happens immediately either way, so the bridge is useful on
  // 12306 right now regardless of Chrome's lifecycle.
  serverInstance
    .start(NATIVE_SERVER_PORT, nativeMessagingHostInstance)
    .then(() => {
      // Plan Z (cont'd): echo SERVER_STARTED to the extension so the popup
      // UI flips from "Service Not Started" to "Running". server.start()
      // normally does this via nativeHost.startServer() (the START-message
      // handler), but we bypassed that path by calling server.start()
      // directly. Replay the message here when a Chrome port is connected.
      // Use a typed cast since `connected` is private; if it's false we
      // simply skip — Chrome isn't actually connected and will reconnect
      // to receive its own SERVER_STARTED on the next START round-trip.
      const connected = (nativeMessagingHostInstance as unknown as { connected: boolean })
        .connected;
      if (connected) {
        nativeMessagingHostInstance.sendMessage({
          type: 'server_started',
          payload: { port: NATIVE_SERVER_PORT },
        });
      }
    })
    .catch((err: unknown) => {
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'EADDRINUSE' || /EADDRINUSE/.test(message)) {
        console.log(
          `[bridge] Port ${NATIVE_SERVER_PORT} already in use; another instance is the primary.`,
        );
        return;
      }
      console.error('[bridge] Failed to auto-start HTTP server:', err);
      process.exit(1);
    });
  nativeMessagingHostInstance.start();
} catch (error) {
  process.exit(1);
}

process.on('error', (error) => {
  process.exit(1);
});

// Handle process signals and uncaught exceptions (Plan Z cont'd: ignore all
// signals so Chrome disconnecting its native-messaging pipes does not take
// the bridge down. Stop the bridge only via Task Manager / Stop-Process.)
const ignoreSignal = () => {
  console.log('[bridge] Signal received; bridge ignores signals and stays up.');
};
process.on('SIGINT', ignoreSignal);
process.on('SIGTERM', ignoreSignal);
process.on('SIGHUP', ignoreSignal);
process.on('SIGBREAK', ignoreSignal);

process.on('exit', (code) => {});

process.on('uncaughtException', (error) => {
  process.stderr.write('[bridge] uncaught=' + String(error) + String.fromCharCode(10));
  // EPIPE (broken pipe on stdout) happens when Chrome disconnects its native
  // messaging stdout before we finish writing. Don't exit the bridge over it -
  // the fastify HTTP server keeps the event loop alive on its own.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EPIPE') {
    return;
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Don't exit immediately, let the program continue running
});
