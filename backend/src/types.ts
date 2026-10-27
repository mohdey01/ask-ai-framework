export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type OperationKind =
  | "create" | "read" | "search" | "update" | "archive" | "delete"
  | "relationship" | "transition" | "message" | "schedule" | "financial"
  | "configuration" | "report";

export type ConfirmationPolicy = "none" | "required";

export interface FieldSchema {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  description: string;
}

export interface ActionSchema {
  fields: Record<string, FieldSchema>;
}

export interface ActionDefinition {
  id: string;
  moduleId: string;
  moduleName: string;
  name: string;
  description: string;
  operation: OperationKind;
  confirmation: ConfirmationPolicy;
  inputSchema: ActionSchema;
  outputSchema: ActionSchema;
  searchTerms: string[];
  handler: ActionHandler;
}

export interface ModuleDefinition {
  id: string;
  name: string;
  description: string;
}

export interface StoredRecord extends JsonObject {
  id: string;
  moduleId: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  status?: string;
}

export interface ActionResult {
  ok: boolean;
  data?: JsonValue;
  error?: { code: string; message: string; details?: JsonObject };
  changed?: boolean;
  simulated?: boolean;
}

export interface HandlerContext {
  store: StorePort;
  action: ActionDefinition;
  traceId: string;
  stepId: string;
}

export type ActionHandler = (input: JsonObject, context: HandlerContext) => Promise<ActionResult> | ActionResult;

export interface StorePort {
  reset(): void;
  list(moduleId: string): StoredRecord[];
  get(moduleId: string, id: string): StoredRecord | undefined;
  create(moduleId: string, fields: JsonObject): StoredRecord;
  update(moduleId: string, id: string, fields: JsonObject): StoredRecord;
  remove(moduleId: string, id: string, archive: boolean): StoredRecord;
  recordMutation(entry: JsonObject): void;
  history(): StoredRecord[];
  failNext(actionId: string, count?: number): void;
  consumeInjectedFailure(actionId: string): boolean;
}

export interface RetrievalHit {
  actionId: string;
  score: number;
  reasons: string[];
}

export interface PlanStep {
  stepId: string;
  actionId: string;
  input: JsonObject;
  dependsOn: string[];
  purpose: string;
  op?: PlanOperation;
  fromStep?: string;
  againstStep?: string;
  field?: string;
  equals?: JsonValue;
  contains?: string;
  limit?: number;
  descending?: boolean;
  forEachFrom?: string;
  excludeBy?: string;
  excludeField?: string;
}

export type PlanOperation = "filter" | "exclude" | "join" | "count" | "sort" | "limit";

export type TraceStatus = "success" | "failed" | "pending_confirmation" | "skipped";

export interface TraceStep {
  stepId: string;
  actionId: string;
  actionName: string;
  status: TraceStatus;
  input: JsonObject;
  output?: JsonValue;
  error?: { code: string; message: string; details?: JsonObject };
  durationMs: number;
  dependsOn: string[];
}

export interface ExecutionMetrics {
  requestMs: number;
  firstUsefulResponseMs: number;
  modelCalls: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ConfirmationPreview {
  planHash: string;
  actions: Array<{ actionId: string; actionName: string; operation: OperationKind; estimatedCount: number }>;
  estimatedMutationCount: number;
  sampleRecordIds: string[];
  targetRecords: Array<{ actionId: string; actionName: string; moduleName: string; id: string; name?: string; email?: string }>;
  safeReadResults: Array<{ stepId: string; count: number; sampleRecordIds: string[] }>;
}

export interface ChatRequest {
  sessionId: string;
  message: string;
  confirmationToken?: string;
  planHash?: string;
  cancelConfirmation?: boolean;
  idempotencyKey?: string;
}

export interface ChatResponse {
  traceId: string;
  status: "completed" | "needs_clarification" | "needs_confirmation" | "unsupported" | "partial" | "cancelled" | "provider_unavailable";
  message: string;
  plan: PlanStep[];
  trace: TraceStep[];
  metrics: ExecutionMetrics;
  context: { selectedIds: string[]; filters: JsonObject };
  executionMode: "offline" | "provider" | "provider_fallback";
  providerError?: { message: string };
  confirmation?: ConfirmationPreview;
  confirmationToken?: string;
}
