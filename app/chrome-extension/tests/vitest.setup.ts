/**
 * @fileoverview Vitest Global Setup
 * @description Provides global configuration and polyfills for test environment
 */

import { vi } from 'vitest';

// Provide IndexedDB globals (jsdom doesn't include them)
import 'fake-indexeddb/auto';

// Mock chrome API (basic placeholder)
if (typeof globalThis.chrome === 'undefined') {
  (globalThis as unknown as { chrome: object }).chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      connect: vi.fn().mockReturnValue({
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      }),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,'),
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      // v1.7.3 (heartbeat race fix): bridge-control.ts attaches these at module
      // load. Anything that transitively imports native-host.ts (screenshot.ts,
      // file-upload.ts, performance.ts, etc.) would crash without these mocks.
      onAttached: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetached: { addListener: vi.fn(), removeListener: vi.fn() },
      onReplaced: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    debugger: {
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      getTargets: vi.fn().mockResolvedValue([]),
      sendCommand: vi.fn().mockResolvedValue({}),
    },
    commands: {
      onCommand: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      remove: vi.fn(),
      onClicked: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    // v1.8.2: chrome.alarms mock for bridge-control.ts alarm path. Test code
    // verifies create({periodInMinutes:0.5}) was called with the right args.
    // NOTE: use mockImplementation (not mockResolvedValue) because the
    // vitest.config.ts `clearMocks: true` flag strips mockReturnValue
    // implementations between tests in some Vitest versions; mockImplementation
    // is preserved. We need a Promise so bridge-control.ts can `.catch()` on it.
    alarms: {
      create: vi.fn().mockImplementation(() => Promise.resolve()),
      clear: vi.fn().mockImplementation(() => Promise.resolve()),
      get: vi.fn().mockImplementation(() => Promise.resolve()),
      onAlarm: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  };
}
