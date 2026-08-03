import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for v1.9 PR#2 integration tests.
 *
 * Notes:
 *   - headless MUST be false (headless Chrome does not support extensions)
 *   - channel: 'chrome' uses system Chrome stable (matches Codex runtime)
 *   - Each test creates a fresh userDataDir to isolate extension state
 *   - timeout: 120s per test (30s heartbeat observation + setup overhead)
 *   - workers: 1 (multiple test instances would conflict on extension state)
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome-stable',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
    },
  ],
});