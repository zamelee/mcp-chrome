/**
 * browser-config.test.ts
 *
 * Patch 3 of 6 (agentify-sh/desktop deep-dive, plan section 2.3).
 *
 * Adapted from agentify-sh/desktop (algorithm only, public domain).
 *   Source: https://github.com/agentify-sh/desktop/blob/main/chrome-cdp-backend.mjs
 *
 * Mocking note: Node ESM imports are non-writable, so we cannot do
 * (fs as any).existsSync = ... inside a test. Instead we use
 * jest.isolateModulesAsync + jest.doMock to swap fs/cp per-test. Tests
 * that need to swap the modules use that pattern; tests that don't
 * (most of them) run with the real fs/cp.
 */

import { describe, expect, test, jest } from "@jest/globals";
import * as os from "os";
import * as fs from "fs";
import {
  BrowserType,
  resolveBrowserExecutable,
  findChromeExecutable,
  ChromeBinaryNotFoundError,
  chromeSpawnOptions,
  parseBrowserType,
} from "./browser-config";

describe("browser-config: resolveBrowserExecutable", () => {
  test("returns null or a real path for any BrowserType", () => {
    const all = [BrowserType.CHROME, BrowserType.CHROMIUM, BrowserType.BRAVE, BrowserType.EDGE];
    for (const b of all) {
      const r = resolveBrowserExecutable(b);
      expect(r === null || typeof r === "string").toBe(true);
    }
  });

  test("every non-null resolved path must point to an existing file", () => {
    const all = [BrowserType.CHROME, BrowserType.CHROMIUM, BrowserType.BRAVE, BrowserType.EDGE];
    for (const b of all) {
      const r = resolveBrowserExecutable(b);
      if (r !== null) {
        expect(fs.existsSync(r)).toBe(true);
      }
    }
  });

  test("priority: when CHROME resolves, findChromeExecutable returns it (no explicit)", () => {
    if (!resolveBrowserExecutable(BrowserType.CHROME)) {
      expect(true).toBe(true);
      return;
    }
    const out = findChromeExecutable();
    expect(out).toBe(resolveBrowserExecutable(BrowserType.CHROME));
  });
});

describe("browser-config: findChromeExecutable", () => {
  test("explicit path takes precedence when it exists on disk", () => {
    const resolved = resolveBrowserExecutable(BrowserType.CHROME)
      || resolveBrowserExecutable(BrowserType.CHROMIUM)
      || resolveBrowserExecutable(BrowserType.BRAVE)
      || resolveBrowserExecutable(BrowserType.EDGE);
    if (!resolved) {
      expect(true).toBe(true);
      return;
    }
    expect(findChromeExecutable(resolved)).toBe(resolved);
  });

  test("throws ChromeBinaryNotFoundError when fs.existsSync always returns false", async () => {
    // Use jest.isolateModulesAsync + jest.doMock to swap fs/cp per-test.
    await jest.isolateModulesAsync(async () => {
      jest.doMock("fs", () => {
        const actual = jest.requireActual("fs");
        return { ...actual, existsSync: () => false };
      });
      jest.doMock("child_process", () => {
        const actual = jest.requireActual("child_process");
        return { ...actual, execSync: () => { throw new Error("not found"); } };
      });
      const { findChromeExecutable: fce, ChromeBinaryNotFoundError: Err } = await import("./browser-config");
      expect(() => fce()).toThrow(Err);
    });
  });

  test("ChromeBinaryNotFoundError carries code + searchedPaths", async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock("fs", () => {
        const actual = jest.requireActual("fs");
        return { ...actual, existsSync: () => false };
      });
      jest.doMock("child_process", () => {
        const actual = jest.requireActual("child_process");
        return { ...actual, execSync: () => { throw new Error("not found"); } };
      });
      const { findChromeExecutable: fce, ChromeBinaryNotFoundError: Err } = await import("./browser-config");
      try {
        fce();
        expect(true).toBe(false);
      } catch (e) {
        const err = e as InstanceType<typeof Err>;
        expect(err).toBeInstanceOf(Err);
        expect(err.code).toBe("chrome_binary_not_found");
        expect(Array.isArray(err.searchedPaths)).toBe(true);
        expect(err.searchedPaths.length).toBeGreaterThan(0);
        expect(err.message).toMatch(/Chrome-family browser executable not found/);
      }
    });
  });

  test("findChromeExecutable without explicit arg uses priority chain", () => {
    try {
      const out = findChromeExecutable();
      expect(fs.existsSync(out)).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(ChromeBinaryNotFoundError);
    }
  });
});

describe("browser-config: chromeSpawnOptions", () => {
  test("Windows spawn hides the console window and uses stdio ignore", () => {
    const opts = chromeSpawnOptions("win32");
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.detached).toBe(true);
  });

  test("macOS spawn omits windowsHide", () => {
    const opts = chromeSpawnOptions("darwin");
    expect(opts.windowsHide).toBeUndefined();
    expect(opts.stdio).toBe("ignore");
    expect(opts.detached).toBe(true);
  });

  test("Linux spawn omits windowsHide", () => {
    const opts = chromeSpawnOptions("linux");
    expect(opts.windowsHide).toBeUndefined();
    expect(opts.stdio).toBe("ignore");
  });

  test("default platform falls back to os.platform()", () => {
    const opts = chromeSpawnOptions();
    if (os.platform() === "win32") {
      expect(opts.windowsHide).toBe(true);
    } else {
      expect(opts.windowsHide).toBeUndefined();
    }
    expect(opts.stdio).toBe("ignore");
  });
});

describe("browser-config: BrowserType enum + parseBrowserType", () => {
  test("parseBrowserType accepts all 4 enum values", () => {
    expect(parseBrowserType("chrome")).toBe(BrowserType.CHROME);
    expect(parseBrowserType("chromium")).toBe(BrowserType.CHROMIUM);
    expect(parseBrowserType("brave")).toBe(BrowserType.BRAVE);
    expect(parseBrowserType("edge")).toBe(BrowserType.EDGE);
  });

  test("parseBrowserType is case-insensitive", () => {
    expect(parseBrowserType("Chrome")).toBe(BrowserType.CHROME);
    expect(parseBrowserType("BRAVE")).toBe(BrowserType.BRAVE);
    expect(parseBrowserType("EdGe")).toBe(BrowserType.EDGE);
  });

  test("parseBrowserType returns undefined for unknown strings", () => {
    expect(parseBrowserType("firefox")).toBeUndefined();
    expect(parseBrowserType("")).toBeUndefined();
    expect(parseBrowserType("safari")).toBeUndefined();
  });

  test("BrowserType enum has exactly 4 values (regression lock)", () => {
    expect(Object.values(BrowserType)).toHaveLength(4);
    expect(Object.values(BrowserType).sort()).toEqual(["brave", "chrome", "chromium", "edge"].sort());
  });
});
