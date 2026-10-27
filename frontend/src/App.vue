<script setup lang="ts">
import { computed, nextTick, ref } from "vue";

type RecordValue = Record<string, unknown>;
type Trace = { stepId: string; actionId: string; actionName: string; status: string; output?: unknown; error?: { message: string } };
type Response = { traceId: string; status: string; message: string; trace: Trace[]; confirmationToken?: string; executionMode: string; providerError?: { message: string }; confirmation?: { planHash: string; estimatedMutationCount: number; sampleRecordIds: string[]; targetRecords?: Array<{ actionName: string; moduleName: string; id: string; name?: string; email?: string }>; actions: Array<{ actionName: string; estimatedCount: number }> }; metrics: { requestMs: number; inputTokens: number; outputTokens: number } };
type Turn = { role: "user" | "assistant"; text: string; response?: Response };

const sessionId = crypto.randomUUID();
const message = ref("");
const turns = ref<Turn[]>([{ role: "assistant", text: "Hi - I can work with the simulated business platform. Try “Create a contact named Sarah with sarah@example.com” or ask me to find quiet leads, skip booked appointments, and create follow-up tasks." }]);
const loading = ref(false);
const error = ref("");
const scrollBox = ref<HTMLElement | null>(null);
const pending = ref<Response | null>(null);
const liveProgress = ref<string[]>([]);

const statusLabel = computed(() => pending.value ? "Confirmation needed" : loading.value ? "Working" : "Ready");

const isRecord = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value));

function resultRows(output: unknown): RecordValue[] {
  if (Array.isArray(output)) return output.filter(isRecord);
  if (!isRecord(output)) return [];
  if (Array.isArray(output.records)) return output.records.filter(isRecord);
  return typeof output.id === "string" ? [output] : [];
}

function resultColumns(rows: RecordValue[]): string[] {
  const preferred = ["id", "name", "status", "amount", "balance", "dueDate", "startsAt", "source", "email", "contactId", "customerId"];
  return preferred.filter((column) => rows.some((row) => row[column] !== undefined)).slice(0, 7);
}

function columnLabel(column: string): string {
  return column.replace(/Id$/, " ID").replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function send(text = message.value, confirmationToken?: string, cancelConfirmation = false) {
  const content = text.trim();
  if (!content && !confirmationToken && !cancelConfirmation) return;
  if (!confirmationToken) { turns.value.push({ role: "user", text: content }); message.value = ""; }
  loading.value = true; error.value = ""; liveProgress.value = [];
  try {
    const result = await fetch("/api/chat/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, message: content || (cancelConfirmation ? "Cancel the protected operation" : "Confirm the protected operation"), confirmationToken, planHash: pending.value?.confirmation?.planHash, cancelConfirmation, idempotencyKey: crypto.randomUUID() }) });
    if (!result.ok) throw new Error("The request failed");
    const response = await readStream(result);
    turns.value.push({ role: "assistant", text: response.message, response });
    pending.value = response.status === "needs_confirmation" ? response : null;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "Unexpected error"; }
  finally { loading.value = false; await nextTick(); scrollBox.value?.scrollTo({ top: scrollBox.value.scrollHeight, behavior: "smooth" }); }
}

async function readStream(streamResponse: globalThis.Response): Promise<Response> {
  if (!streamResponse.body) return await streamResponse.json() as Response;
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Response | null = null;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const eventName = event.match(/^event: (.+)$/m)?.[1];
      const data = event.match(/^data: (.+)$/m)?.[1];
      if (!data) continue;
      const payload = JSON.parse(data) as Trace | Response;
      if (eventName === "progress") liveProgress.value = [...liveProgress.value, (payload as Trace).actionName];
      if (eventName === "complete") completed = payload as Response;
      if (eventName === "error") throw new Error((payload as { error: string }).error);
    }
  }
  if (!completed) throw new Error("The server closed the progress stream without a result");
  return completed;
}

async function reset() {
  await fetch("/api/reset", { method: "POST" });
  turns.value = [{ role: "assistant", text: "Synthetic state reset. What should we do next?" }];
  pending.value = null; error.value = "";
}
</script>

<template>
  <main class="shell">
    <aside class="rail">
      <div class="brand"><span class="brand-mark">✦</span><span>Ask AI</span></div>
      <p class="eyebrow">HIGHLEVEL / SIMULATED</p>
      <h1>Work gets<br /><em>understood.</em></h1>
      <p class="subhead">A stateful agent for the everyday work behind your business.</p>
      <div class="rail-card"><span class="dot green"></span><span>50 modules</span><span class="slash">/</span><span>500 actions</span></div>
      <div class="rail-footer">All effects are simulated<br />and grounded in local state.</div>
    </aside>
    <section class="workspace">
      <header class="topbar"><div><span class="eyebrow">CONVERSATION</span><strong>Workspace assistant</strong></div><div class="top-actions"><span class="status"><span class="dot" :class="loading ? 'amber' : 'green'"></span>{{ statusLabel }}</span><button class="ghost" @click="reset">Reset state</button></div></header>
      <section ref="scrollBox" class="conversation">
        <div class="intro"><span class="intro-line"></span><span>Today · synthetic workspace</span></div>
        <article v-for="(turn, index) in turns" :key="index" class="turn" :class="turn.role">
          <div v-if="turn.role === 'assistant'" class="avatar">✦</div>
          <div class="bubble"><p>{{ turn.text }}</p>
            <div v-if="turn.response" class="execution">
              <div class="execution-head"><span>Execution trace</span><span>{{ turn.response.metrics.requestMs }} ms</span></div>
              <template v-for="step in turn.response.trace" :key="step.stepId">
                <div class="step"><span class="step-icon" :class="step.status">{{ step.status === 'success' ? '✓' : step.status === 'failed' ? '!' : '·' }}</span><span>{{ step.actionName }}</span><code>{{ step.actionId }}</code><small v-if="step.error">{{ step.error.message }}</small></div>
                <div v-if="step.status === 'success' && (Array.isArray(step.output) || resultRows(step.output).length)" class="result-card">
                  <div class="result-card-head"><strong>{{ Array.isArray(step.output) ? step.output.length : resultRows(step.output).length }} result{{ (Array.isArray(step.output) ? step.output.length : resultRows(step.output).length) === 1 ? '' : 's' }}</strong><span>Verified store data</span></div>
                  <div v-if="resultRows(step.output).length" class="result-table-wrap">
                    <table>
                      <thead><tr><th v-for="column in resultColumns(resultRows(step.output))" :key="column">{{ columnLabel(column) }}</th></tr></thead>
                      <tbody><tr v-for="(row, rowIndex) in resultRows(step.output)" :key="String(row.id ?? rowIndex)"><td v-for="column in resultColumns(resultRows(step.output))" :key="column">{{ displayValue(row[column]) }}</td></tr></tbody>
                    </table>
                  </div>
                  <span v-else class="empty-result">No matching records.</span>
                </div>
              </template>
              <div v-if="turn.response.confirmation" class="preview"><strong>Preview</strong><span v-for="target in (turn.response.confirmation.targetRecords ?? [])" :key="`${target.actionName}-${target.id}`">{{ target.actionName }}: {{ target.name || target.id }}<template v-if="target.email"> ({{ target.email }})</template> · {{ target.id }}</span><span v-if="!(turn.response.confirmation.targetRecords?.length) && turn.response.confirmation.sampleRecordIds.length">Records: {{ turn.response.confirmation.sampleRecordIds.join(', ') }}</span><span>{{ turn.response.confirmation.estimatedMutationCount }} estimated mutation(s)</span><span>Plan hash: {{ turn.response.confirmation.planHash.slice(0, 12) }}</span></div>
              <div v-if="turn.response.providerError" class="error">Provider fallback: {{ turn.response.providerError.message }}</div>
              <div class="metrics">{{ turn.response.metrics.inputTokens }} in · {{ turn.response.metrics.outputTokens }} out · actual store result</div>
            </div>
          </div>
        </article>
        <div v-if="loading" class="typing"><span></span><span></span><span></span> {{ liveProgress.length ? liveProgress.join(" · ") : "Planning the request" }}</div>
      </section>
      <footer class="composer-wrap">
        <div v-if="error" class="error">{{ error }}</div>
        <div v-if="pending" class="confirm"><span>This action changes simulated state.</span><button @click="send('', pending?.confirmationToken)">Confirm and continue</button><button class="ghost" @click="send('', pending?.confirmationToken, true)">Cancel</button></div>
        <form class="composer" @submit.prevent="send()"><textarea v-model="message" :disabled="loading" rows="1" placeholder="Ask for something to get done…" @keydown.enter.exact.prevent="send()"></textarea><button class="send" :disabled="loading || !message.trim()" aria-label="Send">↑</button></form>
        <div class="hint">Try: <button @click="send('Find leads who have gone quiet, skip anyone with booked appointments, and create follow-up tasks')">find quiet leads</button><button @click="send('Find overdue invoices, exclude customers reminded this week, and draft email reminders')">draft invoice reminders</button></div>
      </footer>
    </section>
  </main>
</template>
