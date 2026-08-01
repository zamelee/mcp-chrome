import { spawn, execSync } from 'child_process';
import * as os from 'os';

export interface ChromeStatus {
  alive: boolean;
  spawned: boolean;
  pid?: number;
}

/**
 * Probe Chrome and auto-launch if not running. Best-effort, never throws.
 *
 * No --remote-debugging-port needed: mcp-chrome uses native messaging +
 * extension-internal chrome.debugger API, NOT external CDP.
 * Spawns plain chrome.exe / open -a 'Google Chrome' / google-chrome with default
 * user profile (keeps login state, bookmarks, existing extensions including
 * mcp-chrome itself).
 *
 * Returns ChromeStatus. Never throws; spawn failures logged and reported in status.
 */
export async function ensureChrome(): Promise<ChromeStatus> {
  const alive = await isChromeAlive();
  if (alive.alive) {
    console.log(`[ensure-chrome] Chrome already alive (PID ${alive.pid})`);
    return alive;
  }

  console.log('[ensure-chrome] Chrome not running, spawning...');
  const pid = spawnChrome();
  if (!pid) {
    console.warn('[ensure-chrome] Failed to spawn Chrome; user must start it manually');
    return { alive: false, spawned: false };
  }

  // Wait for Chrome to come up (up to 10s, polling every 500ms)
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const check = await isChromeAlive();
    if (check.alive) {
      console.log(`[ensure-chrome] Chrome spawned successfully (PID ${check.pid})`);
      return { alive: true, spawned: true, pid: check.pid };
    }
  }
  console.warn(`[ensure-chrome] Spawn returned PID ${pid} but Chrome not detected after 10s`);
  return { alive: false, spawned: true, pid };
}

async function isChromeAlive(): Promise<ChromeStatus> {
  try {
    const cmd =
      os.platform() === 'win32'
        ? 'tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH'
        : 'pgrep -x chrome || pgrep -x "Google Chrome" || pgrep -x chromium';
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();

    const platform = os.platform();
    let pid: number | undefined;
    if (platform === 'win32') {
      // CSV row: "chrome.exe","12345","Console","1","123,456 K"
      const m = output.match(/^"chrome\.exe","(\d+)"/m);
      pid = m ? parseInt(m[1], 10) : undefined;
    } else {
      const first = output.split('\n')[0]?.trim();
      pid = first && /^\d+$/.test(first) ? parseInt(first, 10) : undefined;
    }
    return pid ? { alive: true, spawned: false, pid } : { alive: false, spawned: false };
  } catch {
    return { alive: false, spawned: false };
  }
}

function spawnChrome(): number | null {
  try {
    const platform = os.platform();
    let cmd: string;
    let args: string[];
    if (platform === 'win32') {
      cmd = 'chrome.exe';
      args = [];
    } else if (platform === 'darwin') {
      cmd = 'open';
      args = ['-a', 'Google Chrome'];
    } else {
      cmd = 'google-chrome';
      args = [];
    }
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid ?? null;
  } catch (e) {
    console.error('[ensure-chrome] spawn error:', (e as Error).message);
    return null;
  }
}
