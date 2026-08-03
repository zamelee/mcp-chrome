/**
 * @fileoverview Heartbeat telemetry collector (v1.9)
 *
 * Records heartbeat events with source attribution (setInterval vs chrome.alarms
 * vs chrome.tabs event vs manual) for the 30min smoke test framework.
 *
 * Output: console.log JSON lines that the maintainer aggregates from user
 * reports. Future v1.10+ may auto-upload to GitHub Issues.
 *
 * Per AGENTS.md §0b.7.7 savePath default zero-disk policy: telemetry is
 * console-only, not persisted locally unless a debug flag enables it.
 */

export type HeartbeatSource = 'setInterval' | 'alarm' | 'chrome.tabs' | 'manual';

export interface HeartbeatTelemetry {
  type: 'heartbeat';
  source: HeartbeatSource;
  scheduledAt: number;
  firedAt: number;
  delayMs: number;
  ownerId: string | null;
  isStale: boolean;
}

const TELEMETRY_BUFFER: HeartbeatTelemetry[] = [];

export function recordHeartbeatTelemetry(meta: HeartbeatTelemetry): void {
  TELEMETRY_BUFFER.push(meta);
  if (TELEMETRY_BUFFER.length > 200) TELEMETRY_BUFFER.shift();
  // Single-line JSON for easy grep / parsing
  console.log(
    '[telemetry] ' + JSON.stringify({
      ...meta,
      buffered: TELEMETRY_BUFFER.length,
    })
  );
}

export function getTelemetryBuffer(): readonly HeartbeatTelemetry[] {
  return TELEMETRY_BUFFER;
}

export function clearTelemetryBuffer(): void {
  TELEMETRY_BUFFER.length = 0;
}

// Test-only escape hatch (matches _resetControlStateForTests pattern)
export function _resetTelemetryBufferForTests(): void {
  TELEMETRY_BUFFER.length = 0;
}
