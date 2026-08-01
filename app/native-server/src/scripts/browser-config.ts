import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { HOST_NAME } from './constant';

export enum BrowserType {
  CHROME = 'chrome',
  CHROMIUM = 'chromium',
  BRAVE = 'brave',
  EDGE = 'edge',
}

export interface BrowserConfig {
  type: BrowserType;
  displayName: string;
  userManifestPath: string;
  systemManifestPath: string;
  registryKey?: string; // Windows only
  systemRegistryKey?: string; // Windows only
}

/**
 * Get the user-level manifest path for a specific browser
 */
function getUserManifestPathForBrowser(browser: BrowserType): string {
  const platform = os.platform();

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(appData, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.CHROMIUM:
        return path.join(appData, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.BRAVE:
        return path.join(appData, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.EDGE:
        return path.join(appData, 'Microsoft', 'Edge', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      default:
        return path.join(appData, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
    }
  } else if (platform === 'darwin') {
    const home = os.homedir();
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.BRAVE:
        return path.join(
          home,
          'Library',
          'Application Support',
          'BraveSoftware',
          'Brave-Browser',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.EDGE:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Microsoft Edge',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else {
    // Linux
    const home = os.homedir();
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          home,
          '.config',
          'google-chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(home, '.config', 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.BRAVE:
        return path.join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.EDGE:
        return path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      default:
        return path.join(
          home,
          '.config',
          'google-chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  }
}

/**
 * Get the system-level manifest path for a specific browser
 */
function getSystemManifestPathForBrowser(browser: BrowserType): string {
  const platform = os.platform();

  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          programFiles,
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(programFiles, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.BRAVE:
        return path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.EDGE:
        return path.join(programFiles, 'Microsoft', 'Edge', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      default:
        return path.join(
          programFiles,
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else if (platform === 'darwin') {
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          '/Library',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(
          '/Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.BRAVE:
        return path.join(
          '/Library',
          'Application Support',
          'BraveSoftware',
          'Brave-Browser',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.EDGE:
        return path.join(
          '/Library',
          'Application Support',
          'Microsoft Edge',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          '/Library',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else {
    // Linux
    switch (browser) {
      case BrowserType.CHROME:
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
      case BrowserType.CHROMIUM:
        return path.join('/etc', 'chromium', 'native-messaging-hosts', `${HOST_NAME}.json`);
      case BrowserType.BRAVE:
        return path.join('/etc', 'brave', 'native-messaging-hosts', `${HOST_NAME}.json`);
      case BrowserType.EDGE:
        return path.join('/etc', 'microsoft-edge', 'native-messaging-hosts', `${HOST_NAME}.json`);
      default:
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
    }
  }
}

/**
 * Get Windows registry keys for a browser
 */
function getRegistryKeys(browser: BrowserType): { user: string; system: string } | undefined {
  if (os.platform() !== 'win32') return undefined;

  const browserPaths: Record<BrowserType, { user: string; system: string }> = {
    [BrowserType.CHROME]: {
      user: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    [BrowserType.CHROMIUM]: {
      user: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    [BrowserType.BRAVE]: {
      user: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    [BrowserType.EDGE]: {
      user: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    },
  };

  return browserPaths[browser];
}

/**
 * Get browser configuration
 */
export function getBrowserConfig(browser: BrowserType): BrowserConfig {
  const registryKeys = getRegistryKeys(browser);

  return {
    type: browser,
    displayName: browser.charAt(0).toUpperCase() + browser.slice(1),
    userManifestPath: getUserManifestPathForBrowser(browser),
    systemManifestPath: getSystemManifestPathForBrowser(browser),
    registryKey: registryKeys?.user,
    systemRegistryKey: registryKeys?.system,
  };
}

/**
 * Detect installed browsers on the system
 */
export function detectInstalledBrowsers(): BrowserType[] {
  const detectedBrowsers: BrowserType[] = [];
  const platform = os.platform();

  if (platform === 'win32') {
    // Check Windows registry for installed browsers
    const browsers: Array<{ type: BrowserType; registryPath: string }> = [
      { type: BrowserType.CHROME, registryPath: 'HKLM\\SOFTWARE\\Google\\Chrome' },
      { type: BrowserType.CHROMIUM, registryPath: 'HKLM\\SOFTWARE\\Chromium' },
      { type: BrowserType.BRAVE, registryPath: 'HKLM\\SOFTWARE\\BraveSoftware\\Brave-Browser' },
      { type: BrowserType.EDGE, registryPath: 'HKLM\\SOFTWARE\\Microsoft\\Edge' },
    ];

    for (const browser of browsers) {
      try {
        execSync(`reg query "${browser.registryPath}" 2>nul`, { stdio: 'pipe' });
        detectedBrowsers.push(browser.type);
      } catch {
        // Browser not installed
      }
    }
  } else if (platform === 'darwin') {
    // Check macOS Applications folder
    const browsers: Array<{ type: BrowserType; appPath: string }> = [
      { type: BrowserType.CHROME, appPath: '/Applications/Google Chrome.app' },
      { type: BrowserType.CHROMIUM, appPath: '/Applications/Chromium.app' },
      { type: BrowserType.BRAVE, appPath: '/Applications/Brave Browser.app' },
      { type: BrowserType.EDGE, appPath: '/Applications/Microsoft Edge.app' },
    ];

    for (const browser of browsers) {
      if (fs.existsSync(browser.appPath)) {
        detectedBrowsers.push(browser.type);
      }
    }
  } else {
    // Check Linux paths using which command
    const browsers: Array<{ type: BrowserType; commands: string[] }> = [
      { type: BrowserType.CHROME, commands: ['google-chrome', 'google-chrome-stable'] },
      { type: BrowserType.CHROMIUM, commands: ['chromium', 'chromium-browser'] },
      { type: BrowserType.BRAVE, commands: ['brave-browser', 'brave'] },
      { type: BrowserType.EDGE, commands: ['microsoft-edge', 'microsoft-edge-stable'] },
    ];

    for (const browser of browsers) {
      for (const cmd of browser.commands) {
        try {
          execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
          detectedBrowsers.push(browser.type);
          break; // Found one command, no need to check others
        } catch {
          // Command not found
        }
      }
    }
  }

  return detectedBrowsers;
}

/**
 * Get all supported browser configs
 */
export function getAllBrowserConfigs(): BrowserConfig[] {
  return Object.values(BrowserType).map((browser) => getBrowserConfig(browser));
}

/**
 * Parse browser type from string
 */
export function parseBrowserType(browserStr: string): BrowserType | undefined {
  const normalized = browserStr.toLowerCase();
  return Object.values(BrowserType).find((type) => type === normalized);
}

/**
 * Patch 3 of 6 (agentify-sh/desktop deep-dive, plan §2.3).
 *
 * Resolve the absolute path of the browser executable for a given BrowserType,
 * by searching the conventional install locations per platform. Pure path
 * search (no exec, no registry) so it's safe to call before any spawn and
 * fully unit-testable.
 *
 * Returns the first path that exists on disk, or null if none of the
 * candidates are present. The caller is responsible for raising
 * `chrome_binary_not_found` when null is returned.
 */
export function resolveBrowserExecutable(browser: BrowserType): string | null {
  const platform = os.platform();
  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    switch (browser) {
      case BrowserType.CHROME:
        candidates.push(
          path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        );
        break;
      case BrowserType.CHROMIUM:
        candidates.push(
          path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
          path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
        );
        break;
      case BrowserType.BRAVE:
        candidates.push(
          path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        );
        break;
      case BrowserType.EDGE:
        candidates.push(
          path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        );
        break;
    }
  } else if (platform === 'darwin') {
    switch (browser) {
      case BrowserType.CHROME:
        candidates.push(
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        );
        break;
      case BrowserType.CHROMIUM:
        candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
        break;
      case BrowserType.BRAVE:
        candidates.push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
        break;
      case BrowserType.EDGE:
        candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
        break;
    }
  } else {
    // Linux
    switch (browser) {
      case BrowserType.CHROME:
        candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome');
        break;
      case BrowserType.CHROMIUM:
        candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
        break;
      case BrowserType.BRAVE:
        candidates.push('/usr/bin/brave-browser', '/usr/bin/brave');
        break;
      case BrowserType.EDGE:
        candidates.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable');
        break;
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Patch 3 of 6 (agentify-sh/desktop deep-dive, plan §2.3).
 *
 * Find a usable Chrome-family executable to spawn for CDP attach.
 *
 * Resolution order:
 *  1. explicitPath (if provided and exists) — used by `pnpm start --chrome-path ...`
 *  2. resolveBrowserExecutable() for each BrowserType in priority order:
 *     CHROME > CHROMIUM > BRAVE > EDGE (Chrome first because CDP semantics
 *     are best-tested there; Brave/Edge as fallback).
 *
 * Throws an Error with code `chrome_binary_not_found` when no candidate
 * resolves, listing the searched paths so the caller can surface them.
 */
export class ChromeBinaryNotFoundError extends Error {
  readonly code = 'chrome_binary_not_found';
  constructor(public readonly searchedPaths: string[]) {
    super(
      `Chrome-family browser executable not found. Searched: ${searchedPaths.join(', ')}`,
    );
    this.name = 'ChromeBinaryNotFoundError';
  }
}

export function findChromeExecutable(explicitPath?: string): string {
  const searched: string[] = [];
  if (explicitPath) {
    searched.push(explicitPath);
    if (fs.existsSync(explicitPath)) {
      return explicitPath;
    }
  }
  // Priority: Chrome first (CDP semantics), then Chromium, then Brave, then Edge.
  const priority: BrowserType[] = [BrowserType.CHROME, BrowserType.CHROMIUM, BrowserType.BRAVE, BrowserType.EDGE];
  for (const browser of priority) {
    const resolved = resolveBrowserExecutable(browser);
    if (resolved) {
      searched.push(resolved);
      return resolved;
    }
    // Track the candidates that were tried for the error message.
    // resolveBrowserExecutable already filters non-existing paths, so we
    // also try via PATH lookup as a final fallback.
  }
  // PATH fallback: ask the shell `which` style helper for each browser's
  // canonical command name.
  const cmdNames: Record<BrowserType, string[]> = {
    [BrowserType.CHROME]: ['chrome', 'google-chrome', 'chrome.exe'],
    [BrowserType.CHROMIUM]: ['chromium', 'chromium-browser', 'chromium.exe'],
    [BrowserType.BRAVE]: ['brave-browser', 'brave', 'brave.exe'],
    [BrowserType.EDGE]: ['microsoft-edge', 'msedge', 'msedge.exe'],
  };
  for (const browser of priority) {
    for (const cmd of cmdNames[browser]) {
      try {
        const which = execSync(
          os.platform() === 'win32' ? `where ${cmd}` : `which ${cmd}`,
          { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' },
        )
          .split(/\r?\n/)[0]
          .trim();
        if (which && fs.existsSync(which)) {
          searched.push(which);
          return which;
        }
        searched.push(cmd);
      } catch {
        searched.push(cmd);
      }
    }
  }
  throw new ChromeBinaryNotFoundError(searched);
}

/**
 * Patch 3 of 6 (agentify-sh/desktop deep-dive, plan §2.3).
 *
 * Spawn options for the Chrome CDP process. Windows-specific regression
 * fix from agentify-sh v0.2.4 changelog: passing `windowsHide: true` and
 * `stdio: 'ignore'` prevents the cmd.exe console window from popping up
 * when launching chrome.exe detached. On macOS/Linux the default is fine.
 *
 * `platform` is optional and defaults to `os.platform()`; tests may pass
 * an override ('win32' / 'darwin' / 'linux') to avoid mocking the os module.
 */
export function chromeSpawnOptions(platform: NodeJS.Platform = os.platform()): { detached?: boolean; stdio?: 'ignore' | 'inherit'; windowsHide?: boolean; shell?: boolean } {
  if (platform === 'win32') {
    return { detached: true, stdio: 'ignore', windowsHide: true };
  }
  return { detached: true, stdio: 'ignore' };
}
