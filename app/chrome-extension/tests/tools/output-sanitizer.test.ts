import { describe, expect, it } from 'vitest';

import { sanitizeText } from '@/utils/output-sanitizer';

describe('output sanitizer query strings', () => {
  it('keeps ordinary text with spaced equals signs and ampersands', () => {
    expect(sanitizeText('prompt: face=unchanged & outfit=unchanged').redacted).toBe(false);
  });

  it('keeps ordinary text with semicolon-separated settings', () => {
    expect(sanitizeText('camera=close-up; lighting=soft; composition=portrait').redacted).toBe(
      false,
    );
  });

  it('does not treat prose containing "side" as a SID cookie', () => {
    expect(
      sanitizeText('prompt {"layout":"side by side"}; relationship=subject; note=done').redacted,
    ).toBe(false);
  });

  it('blocks contiguous query parameters', () => {
    expect(sanitizeText('https://example.com/?token=secret&session=value').text).toBe(
      '[BLOCKED: Cookie/query string data]',
    );
  });

  it('blocks cookies carrying a sensitive key', () => {
    expect(sanitizeText('session=secret; theme=dark').text).toBe(
      '[BLOCKED: Cookie/query string data]',
    );
    expect(sanitizeText('SID=secret; theme=dark').text).toBe('[BLOCKED: Cookie/query string data]');
  });
});

describe('output sanitizer hex vs base64 disambiguation (v1.8.1 patch)', () => {
  // https://github.com/zamelee/mcp-chrome/blob/main/docs/CHANGELOG.md
  // Bug: Hex strings (sha1/md5/sha256) were being labeled [BLOCKED: Base64 encoded data]
  // because [A-Za-z0-9+/]{20,} is a superset of [a-f0-9]{32,}.
  // Fix: Hex check must run BEFORE Base64 check.

  it('sha1 40-char hex → [BLOCKED: Hex credential] (not Base64)', () => {
    const sha1 = 'a'.repeat(40);
    const result = sanitizeText(sha1);
    expect(result.text).toBe('[BLOCKED: Hex credential]');
    expect(result.redacted).toBe(true);
  });

  it('sha256 64-char hex → [BLOCKED: Hex credential] (not Base64)', () => {
    const sha256 = '0123456789abcdef'.repeat(4); // 64 chars
    const result = sanitizeText(sha256);
    expect(result.text).toBe('[BLOCKED: Hex credential]');
    expect(result.redacted).toBe(true);
  });

  it('md5 32-char hex → [BLOCKED: Hex credential] (not Base64)', () => {
    const md5 = '0123456789abcdef0123456789abcdef';
    const result = sanitizeText(md5);
    expect(result.text).toBe('[BLOCKED: Hex credential]');
    expect(result.redacted).toBe(true);
  });

  it('uppercase hex (e.g. SHA-1 with caps) → [BLOCKED: Hex credential]', () => {
    const sha1Caps = 'A'.repeat(40);
    const result = sanitizeText(sha1Caps);
    expect(result.text).toBe('[BLOCKED: Hex credential]');
    expect(result.redacted).toBe(true);
  });

  it('real Base64 (contains +/= chars) → [BLOCKED: Base64 encoded data]', () => {
    // Must contain at least one of `+/=` to be Base64; this string has `=`
    const b64 = 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q=';
    const result = sanitizeText(b64);
    expect(result.text).toBe('[BLOCKED: Base64 encoded data]');
    expect(result.redacted).toBe(true);
  });

  it('hex shorter than 32 chars → NOT redacted (no false positive)', () => {
    // 16 chars is too short for both rules; should pass through
    const short = 'a1b2c3d4e5f60718';
    const result = sanitizeText(short);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(short);
  });
});
