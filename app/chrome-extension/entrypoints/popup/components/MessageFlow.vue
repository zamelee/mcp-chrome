<script setup lang="ts">
/**
 * v1.10.1: Popup double-work communication monitor panel.
 *
 * Collapsed view: 4 counters (IN / OUT / ERR / total) + a hint.
 * Expanded view: scrollable list of last 20 events with timestamp,
 * layer pill (popup / background / native), direction arrow (in/out),
 * message type, and redacted 80-char summary.
 *
 * Re-render throttling: polls every 500ms instead of reacting to every
 * recordMessage() push. Background already debounces storage writes to
 * 500ms so this is a natural cadence.
 */
import { ref, computed, onMounted, onUnmounted, type Ref } from 'vue';
import {
  subscribe as monitorSubscribe,
  hydrateFromStorage as monitorHydrate,
  aggregate as monitorAggregate,
  snapshot as monitorSnapshot,
  clear as monitorClear,
  type MessageTrace,
  type AggregateCounts,
} from '../background/monitor';

const events: Ref<readonly MessageTrace[]> = ref(monitorSnapshot());
const expanded = ref(false);
const counts = computed<AggregateCounts>(() => monitorAggregate(events.value));

let pollHandle: number | null = null;
let unsubscribe: (() => void) | null = null;

onMounted(async () => {
  await monitorHydrate();
  events.value = monitorSnapshot();
  unsubscribe = monitorSubscribe((next) => {
    events.value = next;
  });
  // 500ms poll: ensures fresh data after a reload + decouples from
  // subscriber churn (subscribe/unsubscribe on popup open/close).
  pollHandle = window.setInterval(() => {
    events.value = monitorSnapshot();
  }, 500);
});

onUnmounted(() => {
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
  if (pollHandle !== null) {
    window.clearInterval(pollHandle);
    pollHandle = null;
  }
});

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function onClear(): Promise<void> {
  await monitorClear();
  events.value = monitorSnapshot();
}
</script>

<template>
  <section class="message-flow" data-testid="message-flow">
    <header class="message-flow-header">
      <span class="message-flow-title">Message Flow</span>
      <div class="message-flow-counts">
        <span class="count count-in" title="messages from popup/native into background">
          IN <strong>{{ counts.in }}</strong>
        </span>
        <span class="count count-out" title="messages from background out to popup/native">
          OUT <strong>{{ counts.out }}</strong>
        </span>
        <span class="count count-err" title="errors in the last buffer window" v-if="counts.errors > 0">
          ERR <strong>{{ counts.errors }}</strong>
        </span>
        <span class="count count-total" title="total events in the ring buffer">
          total <strong>{{ counts.total }}</strong>
        </span>
        <button
          type="button"
          class="message-flow-toggle"
          data-testid="message-flow-toggle"
          @click="expanded = !expanded"
          :title="expanded ? 'Hide recent events' : 'Show recent events'"
        >
          <span v-if="expanded">\u25BE</span>
          <span v-else>\u25B4</span>
        </button>
      </div>
    </header>

    <div v-if="expanded" class="message-flow-body" data-testid="message-flow-body">
      <div v-if="events.length === 0" class="message-flow-empty">暂无消息。打开 Codex 跑个 tool 调用会立刻看到。</div>
      <ol v-else class="message-flow-list">
        <li
          v-for="evt in events.slice(-20).reverse()"
          :key="evt.id"
          :class="['message-flow-row', `severity-${evt.severity}`, `direction-${evt.direction}`, `layer-${evt.layer}`]"
          :data-testid="`message-flow-row-${evt.id}`"
        >
          <span class="row-time">{{ formatTime(evt.ts) }}</span>
          <span class="row-arrow" :title="evt.direction === 'in' ? 'received' : 'sent'">
            {{ evt.direction === 'in' ? '\u2193' : '\u2191' }}
          </span>
          <span class="row-layer" :title="evt.layer">{{ evt.layer }}</span>
          <span class="row-type">{{ evt.type }}</span>
          <span class="row-summary">{{ evt.summary }}</span>
        </li>
      </ol>
      <footer class="message-flow-footer">
        <button
          type="button"
          class="message-flow-clear"
          data-testid="message-flow-clear"
          @click="onClear"
        >\u6e05\u7a7a\u65e5\u5fd7</button>
        <span class="message-flow-hint">最多保留 {{ events.length }} 条, 500ms \u5237\u65b0</span>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.message-flow {
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  background: var(--surface-color, #fafafa);
  margin: 8px 0;
  font-size: 12px;
}
.message-flow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
}
.message-flow-title {
  font-weight: 600;
}
.message-flow-counts {
  display: flex;
  gap: 8px;
  align-items: center;
}
.count {
  font-size: 11px;
  opacity: 0.85;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.04);
}
.count-in strong { color: #2563eb; }
.count-out strong { color: #16a34a; }
.count-err strong { color: #dc2626; }
.message-flow-toggle {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0 4px;
  font-size: 12px;
  color: inherit;
}
.message-flow-body {
  border-top: 1px solid var(--border-color, #e5e7eb);
  padding: 6px 0;
}
.message-flow-empty {
  padding: 8px 10px;
  opacity: 0.6;
  font-style: italic;
}
.message-flow-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
.message-flow-row {
  display: grid;
  grid-template-columns: 64px 16px 76px 100px 1fr;
  gap: 6px;
  align-items: baseline;
  padding: 2px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  border-bottom: 1px solid rgba(0, 0, 0, 0.04);
}
.message-flow-row.severity-error {
  background: rgba(220, 38, 38, 0.06);
}
.message-flow-row.severity-warn {
  background: rgba(217, 119, 6, 0.06);
}
.row-time {
  color: rgba(0, 0, 0, 0.5);
}
.row-arrow {
  text-align: center;
}
.row-layer {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.06);
  text-align: center;
}
.row-type {
  font-weight: 500;
}
.row-summary {
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-flow-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  border-top: 1px solid var(--border-color, #e5e7eb);
  font-size: 10px;
  opacity: 0.7;
}
.message-flow-clear {
  background: transparent;
  border: 1px solid var(--border-color, #e5e7eb);
  padding: 1px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 10px;
  color: inherit;
}
.message-flow-clear:hover {
  background: rgba(0, 0, 0, 0.04);
}
</style>