/**
 * popup-gate.test.ts
 *
 * Gate tests for popup-gate.ts. The 13-case matrix mirrors the upstream
 * agentify-sh/desktop tests/popup-policy.test.mjs (MPL-2.0). Each case pins
 * one branch of the gate decision so that future allowlist changes are
 * regression-caught by a specific test.
 *
 * Adapted from agentify-sh/desktop (MPL-2.0).
 *   Source: https://github.com/agentify-sh/desktop/blob/main/tests/popup-policy.test.mjs
 *   License: MPL-2.0
 */

import { describe, expect, test } from "@jest/globals";
import {
  isAllowedAuthPopupUrl,
  shouldAllowPopup,
} from "./popup-gate";

describe("popup-gate: isAllowedAuthPopupUrl (vendor x SSO matrix)", () => {
  test("chatgpt vendor allows Google SSO auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://accounts.google.com/signin/v2/identifier", {
        vendorId: "chatgpt",
      }),
    ).toBe(true);
  });

  test("chatgpt vendor allows OpenAI auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://auth.openai.com/u/login", {
        vendorId: "chatgpt",
      }),
    ).toBe(true);
  });

  test("perplexity vendor allows Google SSO auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://accounts.google.com/signin/v2/identifier", {
        vendorId: "perplexity",
      }),
    ).toBe(true);
  });

  test("claude vendor allows Google SSO auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://accounts.google.com/signin/v2/identifier", {
        vendorId: "claude",
      }),
    ).toBe(true);
  });

  test("aistudio vendor allows Google SSO auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://accounts.google.com/signin/v2/identifier", {
        vendorId: "aistudio",
      }),
    ).toBe(true);
  });

  test("gemini vendor allows Google SSO auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://accounts.google.com/signin/v2/identifier", {
        vendorId: "gemini",
      }),
    ).toBe(true);
  });

  test("grok vendor allows x.com auth popup", () => {
    expect(
      isAllowedAuthPopupUrl("https://x.com/i/flow/login", { vendorId: "grok" }),
    ).toBe(true);
  });

  test("additional Google auth host used in SSO chains is allowed", () => {
    expect(
      isAllowedAuthPopupUrl("https://myaccount.google.com/", {
        vendorId: "gemini",
      }),
    ).toBe(true);
  });

  test("about:blank popup for known vendor opener (OAuth pre-open) is allowed", () => {
    expect(
      shouldAllowPopup({
        url: "about:blank",
        vendorId: "chatgpt",
        openerUrl: "https://chatgpt.com/auth/login",
        frameName: "oauth_popup",
      }),
    ).toBe(true);
  });

  test("about:blank popup for unknown opener is blocked", () => {
    expect(
      shouldAllowPopup({
        url: "about:blank",
        vendorId: "chatgpt",
        openerUrl: "https://malicious-site.example/spam",
        frameName: "oauth_popup",
      }),
    ).toBe(false);
  });

  test("non-https popup URL is blocked", () => {
    expect(
      isAllowedAuthPopupUrl("http://accounts.google.com/signin/v2/identifier", {
        vendorId: "chatgpt",
      }),
    ).toBe(false);
  });

  test("unknown popup URL is blocked", () => {
    expect(
      isAllowedAuthPopupUrl("https://malicious-site.example/spam", {
        vendorId: "chatgpt",
      }),
    ).toBe(false);
  });

  test("globally disabled auth popups via setting returns false", () => {
    expect(
      shouldAllowPopup({
        url: "https://accounts.google.com/signin/v2/identifier",
        vendorId: "chatgpt",
        allowAuthPopups: false,
      }),
    ).toBe(false);
  });
});