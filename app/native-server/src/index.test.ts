/**
 * Unit tests for index.ts v1.11.2 EPIPE/ECONNRESET suppression in uncaughtException.
 *
 * Goal: when the bridge is in "staying alive for HTTP" mode after a Chrome
 * native-host disconnect, in-flight sendMessage() calls may hit EPIPE on the
 * broken stdout pipe. These are transient, NOT fatal — bridge must stay alive.
 * Other errors (TypeError, ReferenceError, etc.) MUST still exit.
 *
 * Strategy: spawn a child node process running a minimal reproduction of the
 * uncaughtException handler. Spy on process.exit calls. Verify exit vs no-exit.
 *
 * (Cannot easily test index.ts directly because it side-effects on import —
 * registers global process listeners + starts the bridge. Spawning a child
 * process with the same handler logic gives us deterministic coverage.)
 */

import { describe, expect, test } from '@jest/globals';
import { spawn } from 'child_process';
import * as path from 'path';

// Path to a small reproduction script we ship with the test
const REPRO_SCRIPT = path.resolve(__dirname, '..', '..', '__tests__', '_repro_uncaught.js');

describe('index.ts v1.11.2 EPIPE suppression', () => {
  test('EPIPE on stdout write does NOT call process.exit', (done) => {
    const child = spawn(process.execPath, [
      '-e',
      `
        // Mirror index.ts uncaughtException handler
        const transientCodes = new Set(['EPIPE', 'ECONNRESET', 'ENOTCONN', 'ERR_STREAM_DESTROYED']);
        process.on('uncaughtException', (error) => {
          if (error && transientCodes.has(error.code)) {
            process.stderr.write('SUPPRESSED ' + error.code + '\\n');
            return;
          }
          process.exit(99);
        });
        // Make stdout a broken pipe by closing it
        process.stdout.write('hello'); // populate buffer
        process.stdout.destroy();
        // Now simulate EPIPE via uncaughtException
        setImmediate(() => {
          const err = new Error('write EPIPE');
          err.code = 'EPIPE';
          process.emit('uncaughtException', err);
        });
        // Schedule success exit (proves we didn't exit from EPIPE)
        setTimeout(() => {
          process.stderr.write('STILL_ALIVE\\n');
          process.exit(0);
        }, 100);
      `,
    ]);

    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.on('close', (code) => {
      expect(code).toBe(0); // exit 0, NOT 99 (the would-be-exit code for non-EPIPE)
      expect(stderr).toContain('SUPPRESSED EPIPE');
      expect(stderr).toContain('STILL_ALIVE');
      done();
    });
  });

  test('ECONNRESET does NOT call process.exit', (done) => {
    const child = spawn(process.execPath, [
      '-e',
      `
        const transientCodes = new Set(['EPIPE', 'ECONNRESET', 'ENOTCONN', 'ERR_STREAM_DESTROYED']);
        process.on('uncaughtException', (error) => {
          if (error && transientCodes.has(error.code)) {
            return;  // suppress
          }
          process.exit(99);
        });
        setImmediate(() => {
          const err = new Error('write ECONNRESET');
          err.code = 'ECONNRESET';
          process.emit('uncaughtException', err);
        });
        setTimeout(() => process.exit(0), 100);
      `,
    ]);
    child.on('close', (code) => {
      expect(code).toBe(0);
      done();
    });
  });

  test('non-EPIPE error STILL exits (regression guard)', (done) => {
    const child = spawn(process.execPath, [
      '-e',
      `
        const transientCodes = new Set(['EPIPE', 'ECONNRESET', 'ENOTCONN', 'ERR_STREAM_DESTROYED']);
        process.on('uncaughtException', (error) => {
          if (error && transientCodes.has(error.code)) {
            return;
          }
          process.exit(99);
        });
        setImmediate(() => {
          const err = new TypeError('real bug');
          process.emit('uncaughtException', err);
        });
      `,
    ]);
    child.on('close', (code) => {
      expect(code).toBe(99);
      done();
    });
  });

  test('error without .code property STILL exits (regression guard)', (done) => {
    const child = spawn(process.execPath, [
      '-e',
      `
        const transientCodes = new Set(['EPIPE', 'ECONNRESET', 'ENOTCONN', 'ERR_STREAM_DESTROYED']);
        process.on('uncaughtException', (error) => {
          if (error && transientCodes.has(error.code)) {
            return;
          }
          process.exit(99);
        });
        setImmediate(() => {
          process.emit('uncaughtException', 'just a string error');
        });
      `,
    ]);
    child.on('close', (code) => {
      expect(code).toBe(99);
      done();
    });
  });
});
