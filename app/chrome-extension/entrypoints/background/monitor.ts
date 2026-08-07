import { STORAGE_KEYS } from '@/common/constants';

/**
 * v1.10.1: Popup double-work communication monitor.
 *
* Lightweight ring buffer that captures `extension <-> background <-> native-host`
* message flow for live display in the popup. Storage-backed via
* `chrome.storage.session` so the buffer survives popup close/reopen within
* the same browser session.
*
* Design principles:
* - In-memory ring buffer (max 200 events). Older events evicted FIFO.
* - Debounced persistence: storage writes batched every 500ms to avoid IO
*   storms (high-frequency tool calls = 100+ msgs/min).
* - Safe summary: payload truncated to 80 chars + JSON-stringified (no raw
*   payloads leak tokens / cookies).
* - Severity bucketing: 'error' for error events, 'warn' for reconnection
*   signals, 'info' for everything else. UI can color accordingly.
* - Layer tagging: 'popup' / 'background' / 'native' so the UI can
*   show source/destination.
 */
export type MessageLayer = 'popup' | 'background' | 'native';
export type MessageDirection = 'in' | 'out';
export type MessageSeverity = 'info' | 'warn' | 'error';

export interface MessageTrace {
  /** Monotonic id assigned by the monitor (caller does not set). */
  id: number;
  /** Unix epoch milliseconds when the event was recorded. */
  ts: number;
  /** Which side of the bridge generated the event. */
  layer: MessageLayer;
  /** in = arriving at this layer; out = leaving this layer toward the next. */
  direction: MessageDirection;
  /** Native message type or background message type identifier. */
  type: string;
  /** Truncated, redacted summary of the payload (max 80 chars, JSON-stringified). */
  summary: string;
  /** Coarse severity hint for UI coloring. */
  severity: MessageSeverity;
}

export const MAX_BUFFER_SIZE = 200;
export const PERSIST_DEBOUNCE_MS = 500;

const buffer: MessageTrace[] = [];
const subscribers = new Set<(events: readonly MessageTrace[]) => void>();
let nextId = 1;
let pendingPersist: ReturnType<typeof setTimeout> | null = null;

function notify(): void {
  const snapshot = buffer.slice();
  for (const cb of subscribers) {
    try {
      cb(snapshot);
    } catch (e) {
      console.warn('[monitor] subscriber threw:', e);
    }
  }
}

function schedulePersist(): void {
  if (pendingPersist !== null) return;
  pendingPersist = setTimeout(() => {
    pendingPersist = null;
    // Snapshot current buffer for storage write.
    const snapshot = buffer.slice();
    void chrome.storage.session.set({ [STORAGE_KEYS.MESSAGE_BUFFER]: snapshot }).catch((e) => {
      console.warn('[monitor] storage.session.set failed:', e);
    });
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Render a payload to a redacted, truncated JSON string. Sensitive-looking
 * keys (`token`, `cookie`, `password`, `bearer`, `secret`) are replaced with
 * `<redacted>` so the UI never accidentally surfaces credentials.
 */
export function safeSummary(payload: unknown): string {
  if (payload == null) return '';
  let s: string;
  try {
    const cloneAndRedact = (v: unknown): unknown => {
      if (v == null) return v;
      if (Array.isArray(v)) return v.map(cloneAndRedact);
      if (typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (/token|cookie|password|bearer|secret/i.test(k)) {
            out[k] = '<redacted>';
          } else {
            out[k] = cloneAndRedact(val);
          }
        }
        return out;
      }
      return v;
    };
    s = JSON.stringify(cloneAndRedact(payload));
  } catch {
    s = String(payload);
  }
  if (s.length > 80) s = s.slice(0, 77) + '...';
  return s;
}

/**
 * Classify severity from a native/background message type + payload.
 * Defaults to 'info'; only specific failure / disconnect signals raise.
 */
export function classifySeverity(type: string, payload: unknown): MessageSeverity {
  if (/error|fail|reject|invalid|unsupported/i.test(type)) return 'error';
  if (payload && typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>;
    if ('error' in p && p.error) return 'error';
    if ('status' in p && typeof p.status === 'string' && /error|fail/i.test(p.status)) return 'error';
  }
  return 'info';
}

/**
 * Record one event into the buffer. Triggers subscriber notification
 * immediately (UI updates without waiting for storage persistence) and
 * schedules a debounced storage write.
 */
export interface RecordMessageInput {
  layer: MessageLayer;
  direction: MessageDirection;
  type: string;
  /** Raw payload to summarize. Will be redacted + truncated to 80 chars. */
  payload?: unknown;
  /** Optional explicit severity (auto-detected from `type` if omitted). */
  severity?: MessageSeverity;
}

export function recordMessage(event: RecordMessageInput): MessageTrace {
  const full: MessageTrace = {
    id: nextId++,
    ts: Date.now(),
    layer: event.layer,
    direction: event.direction,
    type: event.type,
    summary: safeSummary(event.payload),
    severity: event.severity ?? classifySeverity(event.type, event.payload),
  };
  buffer.push(full);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.shift();
  }
  notify();
  schedulePersist();
  return full;
}

/**
 * Restore buffer from persisted storage (called on popup mount).
 */
export async function hydrateFromStorage(): Promise<void> {
  try {
    const data = await chrome.storage.session.get(STORAGE_KEYS.MESSAGE_BUFFER);
    const persisted = Array.isArray(data.messageBuffer) ? data.messageBuffer : [];
    if (persisted.length === 0) return;
    // Replace buffer content (oldest first).
    buffer.length = 0;
    for (const evt of persisted as MessageTrace[]) {
      if (evt && typeof evt.id === 'number') {
        buffer.push(evt);
        if (evt.id >= nextId) nextId = evt.id + 1;
      }
    }
    notify();
  } catch (e) {
    console.warn('[monitor] hydrateFromStorage failed:', e);
  }
}

/**
 * Subscribe to live updates. Returns an unsubscribe function.
 */
export function subscribe(cb: (events: readonly MessageTrace[]) => void): () => void {
  subscribers.add(cb);
  // Emit current snapshot immediately.
  try {
    cb(buffer.slice());
  } catch {
    // ignore
  }
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Read the current buffer snapshot (immutable copy).
 */
export function snapshot(): readonly MessageTrace[] {
  return buffer.slice();
}

/**
 * Clear the buffer (both in-memory and persisted).
 */
export async function clear(): Promise<void> {
  buffer.length = 0;
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.MESSAGE_BUFFER);
  } catch {
    // ignore
  }
  notify();
}

/**
 * Aggregate counts by direction / severity / layer for the collapsed view.
 */
export interface AggregateCounts {
  total: number;
  in: number;
  out: number;
  byLayer: { popup: number; background: number; native: number };
  errors: number;
}

export function aggregate(events: readonly MessageTrace[]): AggregateCounts {
  const counts: AggregateCounts = {
    total: events.length,
    in: 0,
    out: 0,
    byLayer: { popup: 0, background: 0, native: 0 },
    errors: 0,
  };
  for (const e of events) {
    if (e.direction === 'in') counts.in += 1;
    else counts.out += 1;
    counts.byLayer[e.layer] += 1;
    if (e.severity === 'error') counts.errors += 1;
  }
  return counts;
}