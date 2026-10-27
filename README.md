# HighLevel Ask AI Framework

An agentic, multi-module business automation framework built for the HighLevel hiring assignment. It provides a real-time Vue 3 chat interface, a Node.js/TypeScript execution engine, exactly 50 business modules with 10 actions each (500 actions in total), stateful synthetic mock data, human-in-the-loop confirmation gates, execution traces, and reproducible benchmark evaluations.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run local development server (Vue frontend + Node backend)
npm run dev
```

Open the local URL printed by Vite (default: `http://localhost:5173`). For production builds:

```bash
npm run build
npm start
```

### Essential Commands
```bash
npm test                                  # Verify all 500 handlers, schemas, and behavioral tests
npm run evaluate                          # Run offline reproducible 204-scenario evaluation (<1s)
npm run benchmark:provider -- --quick     # Run live LLM benchmark across 8 diversity categories (~2.5 min)
npm run benchmark:provider -- --path=both # Run full 102-scenario live dual-track benchmark (Baseline vs Optimized)
curl http://localhost:8787/api/health     # Healthcheck endpoint
curl http://localhost:8787/api/catalog    # Searchable JSON catalog of all 500 actions
```

---

## 1. Architecture and Agent Design

Ask AI treats user instructions as high-level business goals that decompose into directed acyclic graphs (DAGs) of typed actions across 50 modules.

```mermaid
flowchart TD
  User([User / Browser]) <-->|SSE Stream / JSON| Server[Node.js API Server]
  Server <--> Engine[AskAIEngine]
  Engine --> Retriever[Hybrid Catalog Retriever<br/>(Top-20 Bounded Candidates)]
  Retriever --> Planner[LangGraph StateGraph<br/>+ Zod Plan DSL Schema]
  Planner --> Provider[LLM Provider Adapter<br/>(OpenCode Go / OpenAI)]
  Provider --> Validator[Plan Validation Boundary<br/>(Enforces Retrieved Action Allowlist)]
  Validator --> SafetyGate{Protected / Destructive / Bulk?}
  SafetyGate -->|Yes| Preview[Read-First Preview Card<br/>+ SHA-256 Plan Hash Token]
  Preview --> User
  SafetyGate -->|No / Confirmed| Executor[Deterministic DAG Executor<br/>(Variable Resolution & Code Ops)]
  Executor --> Registry[Action Registry<br/>(500 Typed Handlers)]
  Registry <--> Store[(MockStore<br/>Stateful In-Memory CRM)]
  Executor --> Trace[Execution Trace & SSE Event Stream]
  Trace --> Server
```

### Core Design Principles
1. **Model Proposes, Code Enforces**: The LLM acts strictly as an untrusted planner. It emits structured JSON conforming to the Zod Plan DSL (`intent`, `steps`, `clarification`, `unsupported`). The model has **zero direct access to the database or internal state**.
2. **Strict Allowlist Boundary**: The runtime validates that every action proposed by the model exists in the retrieved candidate set. The model can never invent actions or access modules outside its context.
3. **Deterministic Code Operations**: Dataflow dependencies, entity joins, filtering, and fan-out iterations (`forEach`, `excludeBy`) are executed by deterministic TypeScript runtime logic rather than asking the LLM to do arithmetic or string parsing in prose.
4. **Stateful Working Memory**: Conversation context tracks selected entities (`selectedIds`), active filters, and prior step references (`lastTaskIds`). Follow-up turns reference real entities from memory rather than hallucinating IDs.

---

## 2. Module Catalog, Action Schemas, and Registration Process

The catalog contains **exactly 50 realistic business modules** with **exactly 10 actions per module (500 actions)**, matching the official specification:
- **Core CRM**: Contacts (`M01`), Companies (`M02`), Leads (`M03`), Opportunities (`M04`), Pipelines (`M05`), Tasks (`M06`), Notes (`M07`), Tags (`M08`), Smart Lists (`M09`), Custom Fields (`M10`).
- **Communications**: Conversations (`M11`), SMS (`M12`), Email (`M13`), Message Templates (`M14`), Campaigns (`M15`), Workflows (`M16`), Event Triggers (`M17`).
- **Interactive Forms & Scheduling**: Forms (`M18`), Surveys (`M19`), Calendars (`M20`), Appointments (`M21`), Availability (`M22`), Booking Pages (`M23`), Events (`M24`).
- **Commerce & Billing**: Products (`M25`), Prices (`M26`), Quotes (`M27`), Invoices (`M28`), Payments (`M29`), Subscriptions (`M30`), Coupons (`M31`), Orders (`M32`), Refunds (`M33`), Tax Rules (`M34`).
- **Content & Sites**: Websites (`M35`), Funnels (`M36`), Landing Pages (`M37`), Blogs (`M38`), Media Assets (`M39`).
- **Learning & Community**: Courses (`M40`), Lessons (`M41`), Enrollments (`M42`), Communities (`M43`), Memberships (`M44`), Reviews (`M45`).
- **Administration & Governance**: Business Listings (`M46`), Support Tickets (`M47`), Users (`M48`), Teams (`M49`), Reports (`M50`).

### Action Definition Schema
Each action in `backend/src/catalog.ts` defines:
```typescript
interface ActionDefinition {
  id: string;              // e.g. "M03.A03" (Search leads)
  moduleId: string;        // "M03"
  moduleName: string;      // "Leads"
  name: string;            // "Search leads"
  description: string;     // Purpose & domain usage
  operation: OperationKind;// "create" | "read" | "search" | "update" | "archive" | "delete" | ...
  confirmation: "none" | "required"; // Risk classification
  inputSchema: ActionSchema;
  outputSchema: ActionSchema;
  searchTerms: string[];
  handler: ActionHandler;  // Stateful executable function
}
```

### Extensible Registration
Modules and actions are declared in the catalog and materialized by `createCatalog()` into `ActionRegistry`. Adding a new module or third-party capability requires no changes to the core agent logic—the new action automatically becomes indexed, retrievable, schema-validated, and executable.

---

## 3. Tool Selection, Context Management, and Execution Strategy

### Bounded Action Retrieval (Top 20)
Sending 500 tool schemas to an LLM increases prompt size, latency, and planning noise. Ask AI currently uses a measured lexical retrieval path:
1. **Tokenization & Exact Phrase Matching**: Matches action names, module keywords, and synonym stems.
2. **Operation Filtering**: Upweights `search`/`read` actions for discovery queries and `create`/`update` actions for imperative requests.
3. **Module Diversification**: Caps candidate actions at 3 per module to avoid cluster bias.
4. **Bounded Injection**: Injects the top 20 candidate actions into the LLM prompt with compacted parameter lists, cutting prompt size by approximately **94.6%** in the final live run. Embedding retrieval remains a future upgrade, not a current claim.

### Context Management
Multi-turn conversations retain state in `SessionContext`:
- `selectedIds`: IDs of records viewed or targeted in previous turns.
- `lastTaskIds`: Created tasks available for immediate due date or status modification.
- `filters`: Active filters applied during searches.
- `lastPlan`: Prior DAG execution steps.

### Execution Strategy
When a plan is returned:
1. **DAG Topological Sort**: Validates step dependencies and ensures prerequisite steps execute first.
2. **Variable Resolution**: Step inputs dynamically resolve upstream references (e.g., `leadId: "$s1.id"` or `forEachFrom: "s1"`).
3. **Safety Gate**: If any step has `confirmation: "required"` or mutates multiple records in bulk:
   - Safe read-only prerequisite steps execute first to inspect state.
   - Generates a **Confirmation Preview Card** displaying estimated mutations, affected record IDs, and a canonical SHA-256 plan hash (`backend/src/plan_hash.ts`).
   - Pauses execution until the user explicitly clicks **Confirm** in the UI.

---

## 4. What Is Real versus Mocked

| Component | Status | Implementation Details |
|:---|:---:|:---|
| **Node.js HTTP Server & SSE Streaming** | **REAL** | Native Node.js HTTP server supporting Server-Sent Events (`POST /api/chat/stream`). |
| **Vue 3 Chat Interface** | **REAL** | Interactive web application with real-time progress steps, trace viewer, and confirmation cards. |
| **LLM Provider & LangGraph Planner** | **REAL** | Live API integration (OpenCode Go `qwen3.8-flash` / OpenAI) with LangGraph orchestration. |
| **Catalog & Schema Validation** | **REAL** | 500 typed actions validated at runtime using Zod. |
| **Business Data & Side Effects** | **MOCKED** | Synthetic in-memory database (`MockStore`). Sending SMS/emails, payment captures, and external webhooks are simulated state transitions; no live HighLevel account is charged or contacted. |

---

## 5. How to Run Evaluations and Reproduce Results

### 1. Offline Deterministic Evaluation (204 Scenarios)
Tests exact action mapping, parameter extraction, and store state changes without external network dependencies:
```bash
npm run evaluate
```
*Outputs detailed metrics in `evaluation/results.json` in $<1$ second.*

### 2. Live Provider Benchmark (Diversity Sample)
Tests 8 diverse scenario categories (direct, indirect, complex, follow-up, ambiguous, unsupported, confirmation, invalid) against live LLM:
```bash
npm run benchmark:provider -- --quick --path=optimized
```

### 3. Full Dual-Track Live Benchmark (102 Scenarios × 2 Tracks)
Compares the full 500-tool baseline against the top-20 hybrid optimized path:
```bash
npm run benchmark:provider -- --path=both --concurrency=2 --resume
```
*Incremental checkpoints are saved to `evaluation/.benchmark_cache.json` after every scenario. Full report written to `evaluation/provider-results.json`.*

For repeated independent runs, add a unique ID to preserve each report and checkpoint:
```bash
npm run benchmark:provider -- --path=both --concurrency=2 --run-id=repeat-1
```

---

## 6. Latency, Cost, and Quality Trade-offs

Empirical benchmark measurements conducted on the 102 held-out test scenarios using **OpenCode Go (`qwen3.8-flash`)**. Input/output tokens and model calls are measured from provider responses. OpenCode Go does not expose a verified per-token USD rate for this model, so actual OpenCode cost is **not measured**. Any USD values produced by configuring `ASK_AI_INPUT_COST_PER_1M` and `ASK_AI_OUTPUT_COST_PER_1M` must be labeled as a normalized proxy estimate, not OpenCode billing.

| Metric | Baseline (All 500 Actions in Prompt) | Optimized (Top-20 Bounded Lexical Retrieval) | Architectural Delta / Trade-off |
|:---|:---:|:---:|:---|
| **Evaluated Scenarios** | 102 | 102 | Identical held-out test distribution |
| **End-to-End Pass Rate** | **96 / 102 (94.1%)** | **99 / 102 (97.1%)** | Optimized passed 3 more scenarios |
| **Provider Fallbacks** | **6** | **3** | Optimized had 50% fewer fallbacks |
| **Total Input Tokens** | **2,433,609 tokens** | **131,919 tokens** | **94.6% token reduction** (18.4× smaller payload) |
| **Input Tokens / Call** | **23,859 tokens** | **1,293 tokens** | Saved ~22,566 input tokens per prompt |
| **Total Output Tokens** | 45,557 tokens | 44,609 tokens | Similar output plan generation |
| **p50 Latency (TTFR)** | **8.62s** | **6.89s** | **20.1% faster response time** |
| **p95 Latency** | **35.01s** | **23.95s** | **31.6% lower tail latency in this run** |
| **Cost per 100k Calls** | Not measured | Not measured | Any configured USD value is a clearly labeled proxy estimate |

### Key Trade-off Takeaway
The optimized path reduced input tokens by **94.6%**, improved p50 response time by **20.1%**, and had fewer provider fallbacks in the final run. Tail latency remains provider-dependent: this run included isolated timeout outliers, so the result should be presented as one live sample rather than a universal SLA. Cost efficiency is demonstrated through measured token reduction; actual OpenCode USD cost is not claimed. If reference rates are configured locally, the resulting USD figure must be presented as a proxy estimate.

---

## 7. Known Limitations and Scaling Beyond 500 Actions

### Current Limitations
1. **Lexical Stemming Boundary**: Pure lexical retrieval can miss novel paraphrases that share zero root words with the action title or description.
2. **Process-Local Store**: The mock store resides in memory and resets across process restarts.
3. **Simulated External Effects**: Integrations (Stripe, Twilio, SendGrid) are simulated state machines rather than real wire calls.

### Scaling to 5,000+ Actions
To scale from 500 to thousands of actions across enterprise sub-accounts:
1. **Hierarchical Two-Stage Retrieval**:
   - Stage 1: Vector search (HNSW index on module embeddings) routes the request to the top 3–5 relevant business domains.
   - Stage 2: Dense action-level ranking retrieves the top 15 action candidates within those modules.
2. **Tenant-Partitioned Tool Catalogs**: Filter candidate actions by active tenant license, user permissions (RBAC), and installed App Marketplace integrations before retrieval.
3. **Sub-Agent Decomposition**: For complex cross-department workflows, delegate to specialized sub-agents (e.g. Sales Agent, Invoicing Agent) running focused tool catalogs.

---

## 8. Demo Walkthrough (2–5 Minutes)

When recording or presenting the live demo, execute these exact scenarios in the chat UI:

1. **Grounded seeded read**:
   - Query: `"Show overdue invoices"`
   - *Verifies*: Two seeded overdue invoices, actual store output, and a readable execution trace.
2. **Direct create plus stateful follow-up**:
   - Queries: `"Create a contact named Priya Shah with priya@example.com"`, then `"Create a task named Follow up with Priya"`, then `"Set that task due on 2026-10-28"`.
   - *Verifies*: Provider-generated parameters, persisted IDs, multi-turn entity continuity, and `M06.A06` updates. Use an absolute date for a deterministic demo.
3. **Complex Multi-Step Workflow (3+ Modules)**:
   - Query: `"Find overdue invoices, exclude customers reminded this week, and draft email reminders"`
   - *Verifies*: Cross-module DAG across Invoices (`M28.A10`), Email Search (`M13.A07`), and Email Draft (`M13.A01`).
4. **Confirmation Gate for Protected Operation**:
   - Query: `"Archive contact M01-0001"`
   - *Verifies*: Engine pauses, surfaces read-first preview card with SHA-256 token, and executes only upon clicking **Confirm**. Reset state afterward.
5. **Ambiguity & Clarification**:
   - Query: `"Create a contact"`
   - *Verifies*: System asks for the missing contact name rather than hallucinating placeholder data.
6. **Benchmark Report Presentation**:
   - Show `EVALUATION.md` and `evaluation/provider-results-final.json` demonstrating the empirical Baseline vs Optimized comparison.
