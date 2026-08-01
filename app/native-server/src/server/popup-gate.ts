/**
 * popup-gate.ts
 *
 * Policy module that decides whether a browser popup window should be allowed
 * to open during a vendor web session (chatgpt.com / gemini.google.com / claude.ai /
 * perplexity.ai / grok.com / aistudio.google.com).
 *
 * Adapted from agentify-sh/desktop (MPL-2.0).
 *   Source: https://github.com/agentify-sh/desktop/blob/main/popup-policy.mjs
 *   Upstream commit: 0.2.4 (2026-05-17)
 *   License: MPL-2.0
 *
 * Per AGENTS.md sec 13 (chrome-relay fork policy) we do NOT fork the upstream
 * project. We port the gate logic into TypeScript with our own test matrix; the
 * upstream file is the source of truth for the allowlist contents.
 *
 * Why this exists:
 *   When chatgpt.com / Gemini / Claude needs to run an OAuth flow (Google SSO,
 *   Microsoft SSO, GitHub, X/Twitter), they open a popup window. Chrome
 *   extensions that intercept popups by default may block the OAuth flow, which
 *   cascades into a "_ref is not defined" React crash (chatgpt backend then
 *   returns 403 because the session state is corrupted). This module lets the
 *   caller answer "should this popup URL be allowed?" in a vendor-aware way.
 *
 * Gate layers (per upstream popup-policy.mjs):
 *   1. Protocol must be https:
 *   2. Hostname must match CHATGPT_AUTH_HOST_ALLOWLIST
 *   3. Vendor id must be in SUPPORTED_VENDOR_IDS
 *   4. Special case for `about:blank` OAuth pre-open popups (frameName/disposition)
 *
 * The original chatgpt-only allowlist name is kept for compatibility (we may
 * rename once we add Gemini/Claude/Copilot-specific allowlists if the upstream
 * doesn't cover their SSO providers).
 */

// ----- Types -----

/** Vendor id used to scope auth host allowlists. */
export type VendorId = "chatgpt" | "perplexity" | "claude" | "aistudio" | "gemini" | "grok";

/** Inputs to {@link shouldAllowPopup}. */
export interface ShouldAllowPopupInput {
  /**
   * Popup URL to evaluate. Optional because the gate is sometimes called with
   * `about:blank` for the OAuth pre-open case where the URL alone is not
   * informative. Missing URL is treated as "deny" downstream.
   */
  url?: string;
  /** Vendor id that initiated the popup. Defaults to "chatgpt". */
  vendorId?: string;
  /**
   * Global toggle: if false, all auth popups are denied. The default reflects
   * the upstream default (true). Callers (operator UI / settings) can flip this.
   */
  allowAuthPopups?: boolean;
  /** Opener page URL (used only for the about:blank special case). */
  openerUrl?: string;
  /** window.open frame name. */
  frameName?: string;
  /** Browser disposition (foreground-tab / background-tab / new-window / ""). */
  disposition?: string;
}

// ----- Allowlists -----

/**
 * Allowlist of auth host patterns. A pattern starting with "." matches the
 * domain and all subdomains; an exact pattern matches only that host.
 *
 * NOTE: kept under the original name (CHATGPT_AUTH_HOST_ALLOWLIST) because the
 * same SSO providers (Google / Microsoft / Apple / GitHub / X) are used by all
 * six supported vendors. If a vendor requires an extra SSO host we did not
 * anticipate, add it here and pin a regression test.
 */
export const CHATGPT_AUTH_HOST_ALLOWLIST: readonly string[] = [
  // OpenAI / ChatGPT auth surfaces
  "chatgpt.com",
  ".chatgpt.com",
  "openai.com",
  ".openai.com",

  // Common SSO providers used by ChatGPT users
  "accounts.google.com",
  "accounts.youtube.com",
  "myaccount.google.com",
  "ogs.google.com",
  ".google.com",
  ".googleusercontent.com",
  "login.live.com",
  ".live.com",
  ".microsoft.com",
  ".microsoftonline.com",
  "appleid.apple.com",
  ".apple.com",
  "github.com",
  ".github.com",

  // X/Twitter auth surfaces (used by Grok accounts)
  "x.com",
  ".x.com",
  "twitter.com",
  ".twitter.com",
  "grok.com",
  ".grok.com",
] as const;

/** Vendor ids that the gate recognises. */
export const SUPPORTED_VENDOR_IDS: readonly VendorId[] = [
  "chatgpt",
  "perplexity",
  "claude",
  "aistudio",
  "gemini",
  "grok",
] as const;

/**
 * Vendor host allowlist (used by the about:blank OAuth pre-open special case to
 * decide whether the opener is from a supported vendor). Separate from the auth
 * host allowlist because it answers a different question: "is the opener URL on
 * a vendor we know?".
 */
export const VENDOR_HOST_ALLOWLIST: readonly string[] = [
  "chatgpt.com",
  ".chatgpt.com",
  "claude.ai",
  ".claude.ai",
  "gemini.google.com",
  ".gemini.google.com",
  "aistudio.google.com",
  ".aistudio.google.com",
  "perplexity.ai",
  ".perplexity.ai",
  "grok.com",
  ".grok.com",
] as const;

// ----- Hostname helpers -----

/** Lowercase, trim, strip trailing dots. Mirrors upstream normalizeHostname. */
export function normalizeHostname(hostname: string | null | undefined): string {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
}

/** Match hostname against a pattern (exact or wildcard with leading dot). */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const h = normalizeHostname(hostname);
  const p = normalizeHostname(pattern);
  if (!h || !p) return false;
  if (p.startsWith(".")) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

// ----- Gate decision -----

/**
 * Layer 1+2+3: protocol + auth-host allowlist + vendor allowlist.
 * Returns true iff the popup URL is https and its host matches the auth allowlist
 * AND the vendor id is supported.
 */
export function isAllowedAuthPopupUrl(
  url: string,
  { vendorId = "chatgpt" }: { vendorId?: string } = {},
): boolean {
  let u: URL;
  try {
    u = new URL(String(url || ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;

  const host = normalizeHostname(u.hostname);
  if (!host) return false;

  const vendor = String(vendorId || "chatgpt").trim().toLowerCase();
  if (!(SUPPORTED_VENDOR_IDS as readonly string[]).includes(vendor)) return false;

  return CHATGPT_AUTH_HOST_ALLOWLIST.some((pattern) => hostMatchesPattern(host, pattern));
}

/**
 * Layer 4: about:blank OAuth pre-open popup.
 *
 * OAuth flows often open `about:blank` first, then redirect to the actual SSO
 * provider URL. The browser only tells us about the about:blank URL, plus the
 * opener URL, frame name, and disposition. We treat it as allowed iff:
 *   - popup url is exactly "about:blank"
 *   - frame name contains oauth/auth/signin/login OR
 *     disposition is new-window/foreground-tab/background-tab (or empty)
 *   - opener URL is a vendor host or an auth host
 */
export function isAllowedBlankAuthPopup({
  url,
  vendorId = "chatgpt",
  openerUrl = "",
  frameName = "",
  disposition = "",
}: {
  url?: string;
  vendorId?: string;
  openerUrl?: string;
  frameName?: string;
  disposition?: string;
} = {}): boolean {
  const vendor = String(vendorId || "chatgpt").trim().toLowerCase();
  if (!(SUPPORTED_VENDOR_IDS as readonly string[]).includes(vendor)) return false;

  const popupUrl = String(url || "").trim().toLowerCase();
  if (popupUrl !== "about:blank") return false;

  const disp = String(disposition || "").trim().toLowerCase();
  const frame = String(frameName || "").trim().toLowerCase();
  const looksLikeAuthPopup =
    frame.includes("oauth") ||
    frame.includes("auth") ||
    frame.includes("signin") ||
    frame.includes("login") ||
    disp === "new-window" ||
    disp === "foreground-tab" ||
    disp === "background-tab" ||
    disp === "";
  if (!looksLikeAuthPopup) return false;

  let openerHost = "";
  try {
    openerHost = normalizeHostname(new URL(String(openerUrl || "")).hostname);
  } catch {
    return false;
  }
  if (!openerHost) return false;

  const isVendorHost = VENDOR_HOST_ALLOWLIST.some((pattern) =>
    hostMatchesPattern(openerHost, pattern),
  );
  const isTrustedAuthHost = CHATGPT_AUTH_HOST_ALLOWLIST.some((pattern) =>
    hostMatchesPattern(openerHost, pattern),
  );
  return isVendorHost || isTrustedAuthHost;
}

/**
 * Composite decision: layer 1+2+3 first, fallback to layer 4 (about:blank).
 *
 * Returns true iff:
 *   - allowAuthPopups is true, AND
 *   - either isAllowedAuthPopupUrl OR isAllowedBlankAuthPopup is true
 */
export function shouldAllowPopup({
  url,
  vendorId = "chatgpt",
  allowAuthPopups = true,
  openerUrl = "",
  frameName = "",
  disposition = "",
}: ShouldAllowPopupInput = {}): boolean {
  if (!allowAuthPopups) return false;
  if (url && isAllowedAuthPopupUrl(url, { vendorId })) return true;
  return isAllowedBlankAuthPopup({ url, vendorId, openerUrl, frameName, disposition });
}