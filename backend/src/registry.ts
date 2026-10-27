import { createCatalog, MODULES } from "./catalog.js";
import type { ActionDefinition, ActionResult, JsonObject, OperationKind, StorePort, StoredRecord } from "./types.js";

const ok = (data: unknown, extra: Partial<ActionResult> = {}): ActionResult => ({ ok: true, data: data as ActionResult["data"], ...extra });
const fail = (code: string, message: string, details?: JsonObject): ActionResult => ({ ok: false, error: { code, message, details } });
const lower = (value: string) => value.toLowerCase();

function firstRecord(store: StorePort, moduleId: string, id?: string): StoredRecord | undefined {
  if (id) return store.get(moduleId, id);
  return store.list(moduleId)[0];
}

function requiredString(input: JsonObject, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fieldsOf(input: JsonObject): JsonObject {
  const normalized = { ...input };
  delete normalized.fields;
  delete normalized.id;
  const nested = input.fields;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? { ...nested as JsonObject, ...normalized }
    : normalized;
}

function validateReferences(store: StorePort, fields: JsonObject): ActionResult | undefined {
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== "string" || !/^M\d{2}-\d{4}$/.test(value)) continue;
    const moduleId = value.slice(0, 3);
    if (!store.get(moduleId, value)) return fail("INVALID_REFERENCE", `${field} references missing record ${value}.`);
  }
  return undefined;
}

const transitionStatus = (name: string): string | undefined => {
  const action = lower(name);
  if (action.includes("publish") || action.includes("launch")) return "published";
  if (action.includes("unpublish")) return "unpublished";
  if (action.includes("pause")) return "paused";
  if (action.includes("resume")) return "active";
  if (action.includes("complete") || action.includes("check in")) return "completed";
  if (action.includes("close")) return "closed";
  if (action.includes("reopen")) return "open";
  if (action.includes("approve") || action.includes("accept")) return "approved";
  if (action.includes("reject")) return "rejected";
  if (action.includes("cancel")) return "cancelled";
  if (action.includes("revoke")) return "revoked";
  if (action.includes("suspend")) return "suspended";
  if (action.includes("deactivate") || action.includes("disable")) return "inactive";
  if (action.includes("enable") || action.includes("activate")) return "active";
  if (action.includes("mark") && action.includes("won")) return "won";
  if (action.includes("mark") && action.includes("lost")) return "lost";
  if (action.includes("no-show")) return "no_show";
  return undefined;
};

function makeHandler(raw: { id: string; moduleId: string; moduleName: string; name: string; operation: OperationKind; confirmation: "none" | "required" }) {
  return (input: JsonObject, context: { store: StorePort }): ActionResult => {
    const { store } = context;
    const action = lower(raw.name);
    const id = typeof input.id === "string" ? input.id : undefined;
    const fields = fieldsOf(input);

    const referenceError = validateReferences(store, fields);
    if (referenceError) return referenceError;
    if (fields.amount !== undefined && (typeof fields.amount !== "number" || fields.amount < 0)) return fail("INVALID_AMOUNT", "amount must be a non-negative number.");

    if (raw.operation === "create") {
      const name = typeof fields.name === "string" && fields.name.trim() ? fields.name : `${raw.name} result`;
      return ok(store.create(raw.moduleId, { ...fields, name, sourceAction: raw.id }), { changed: true, simulated: action.includes("simulated") });
    }

    if (raw.operation === "search" || raw.operation === "read") {
      if (raw.operation === "read" && (action.startsWith("get") || action.startsWith("view")) && id) {
        const record = store.get(raw.moduleId, id);
        return record ? ok(record) : fail("NOT_FOUND", `No ${raw.moduleName} record exists with id ${id}.`);
      }
      if (raw.operation === "read" && action.startsWith("get") && !id) return fail("MISSING_ID", `${raw.name} needs a record id.`);
      const rawQuery = typeof input.query === "string" ? lower(input.query).trim() : "";
      const allRecords = store.list(raw.moduleId);
      let records = allRecords;
      if (rawQuery) {
        // Appointments identify contacts by contactId, so resolve a natural-language
        // contact name before applying the normal record search. This keeps queries
        // such as “appointments for Sarah Chen” relationship-aware without making
        // the generic search handler aware of every module relationship.
        const relatedContact = raw.moduleId === "M21"
          ? store.list("M01").find((contact) => {
            const contactName = lower(String(contact.name ?? "")).trim();
            const contactEmail = lower(String(contact.email ?? "")).trim();
            const queryTokens = rawQuery.split(/[^a-z0-9@._-]+/).filter((token) => token.length > 2);
            const nameTokens = contactName.split(/[^a-z0-9]+/).filter((token) => token.length > 2);
            return Boolean(contactEmail && rawQuery.includes(contactEmail))
              || Boolean(contactName && rawQuery.includes(contactName))
              || (nameTokens.length > 0 && nameTokens.every((token) => queryTokens.includes(token)));
          })
          : undefined;
        if (relatedContact) {
          records = allRecords.filter((record) => record.contactId === relatedContact.id);
        } else {
          const exact = allRecords.filter((record) => lower(JSON.stringify(record)).includes(rawQuery));
          if (exact.length > 0) {
            records = exact;
          } else {
            const stopwords = new Set(["leads", "contacts", "invoices", "tasks", "records", "emails", "items", "who", "have", "gone", "with", "for", "from", "the", "and", "help", "stay", "top", "them"]);
            const tokens = rawQuery.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !stopwords.has(t));
            const tokenMatches = tokens.length > 0 ? allRecords.filter((record) => {
              const s = lower(JSON.stringify(record));
              return tokens.some((token) => s.includes(token));
            }) : [];
            records = tokenMatches.length > 0 ? tokenMatches : allRecords;
          }
        }
      }
      if (action.startsWith("count")) return ok({ count: records.length });
      if (action.startsWith("check") || action.startsWith("preview")) return ok({ count: records.length, records });
      return ok(records);
    }

    if (raw.operation === "archive" || raw.operation === "delete") {
      if (!id) return fail("MISSING_ID", `${raw.name} needs a record id.`);
      const record = firstRecord(store, raw.moduleId, id);
      if (!record) return fail("NOT_FOUND", `Cannot ${raw.name.toLowerCase()}: record ${id ?? ""} was not found.`);
      return ok(store.remove(raw.moduleId, record.id, raw.operation === "archive"), { changed: true, simulated: action.includes("simulated") });
    }

    if (["update", "relationship", "transition", "message", "financial", "schedule"].includes(raw.operation) && !id) {
      return fail("MISSING_ID", `${raw.name} needs a record id.`);
    }

    const record = firstRecord(store, raw.moduleId, id);
    if (!record) return fail("NOT_FOUND", `No ${raw.moduleName} record exists with id ${id ?? ""}.`);

    if (raw.id === "M02.A06" || raw.id === "M02.A07") {
      const contactId = requiredString(fields, "contactId");
      if (!contactId || !store.get("M01", contactId)) return fail("INVALID_REFERENCE", "contactId must identify an existing contact.");
      const existing = Array.isArray(record.contactIds) ? record.contactIds.filter((value): value is string => typeof value === "string") : [];
      const next = raw.id === "M02.A06" ? [...new Set([...existing, contactId])] : existing.filter((value) => value !== contactId);
      const company = store.update("M02", record.id, { contactIds: next, lastAction: raw.name });
      store.update("M01", contactId, { companyId: raw.id === "M02.A06" ? record.id : undefined, lastAction: raw.name });
      return ok(company, { changed: true });
    }

    if (raw.id === "M01.A09") {
      const relatedContactId = requiredString(fields, "relatedContactId");
      if (!relatedContactId || relatedContactId === record.id || !store.get("M01", relatedContactId)) return fail("INVALID_REFERENCE", "relatedContactId must identify a different existing contact.");
      const relationships = Array.isArray(record.relationships) ? record.relationships.filter((value): value is string => typeof value === "string") : [];
      const other = store.get("M01", relatedContactId);
      const otherRelationships = Array.isArray(other?.relationships) ? other.relationships.filter((value): value is string => typeof value === "string") : [];
      const current = store.update("M01", record.id, { relationships: [...new Set([...relationships, relatedContactId])], lastAction: raw.name });
      store.update("M01", relatedContactId, { relationships: [...new Set([...otherRelationships, record.id])], lastAction: raw.name });
      return ok(current, { changed: true });
    }

    if (raw.id === "M03.A10") {
      const opportunity = store.create("M04", { name: `${record.name ?? "Lead"} opportunity`, leadId: record.id, contactId: record.contactId, status: "open", sourceAction: raw.id });
      const lead = store.update("M03", record.id, { status: "converted", opportunityId: opportunity.id, lastAction: raw.name });
      return ok({ lead, opportunity }, { changed: true });
    }

    if (raw.id === "M27.A10") {
      if (record.status !== "accepted") return fail("INVALID_TRANSITION", "Only an accepted quote can be converted to an invoice.");
      const invoice = store.create("M28", { name: `Invoice for ${record.name ?? record.id}`, quoteId: record.id, customerId: record.customerId, amount: record.total ?? 0, balance: record.total ?? 0, status: "draft" });
      const quote = store.update("M27", record.id, { invoiceId: invoice.id, lastAction: raw.name });
      return ok({ quote, invoice }, { changed: true });
    }

    if (raw.id === "M29.A07") {
      const invoiceId = requiredString(fields, "invoiceId");
      const invoice = invoiceId ? store.get("M28", invoiceId) : undefined;
      if (!invoice) return fail("INVALID_REFERENCE", "invoiceId must identify an existing invoice.");
      const payment = store.update("M29", record.id, { invoiceId, status: "allocated", allocatedAmount: fields.amount ?? record.amount ?? 0, lastAction: raw.name });
      store.update("M28", invoice.id, { paymentId: record.id, balance: 0, status: "paid", lastAction: raw.name });
      return ok(payment, { changed: true });
    }

    const status = transitionStatus(raw.name);
    if (status) return ok(store.update(raw.moduleId, record.id, { ...fields, status, lastAction: raw.name }), { changed: true, simulated: action.includes("simulated") || raw.operation === "message" });

    if (raw.operation === "relationship") {
      const relationship = { ...fields, relationshipAction: raw.name };
      return ok(store.update(raw.moduleId, record.id, relationship), { changed: true });
    }

    if (raw.operation === "report") {
      const records = store.list(raw.moduleId);
      return ok({ module: raw.moduleName, count: records.length, statuses: records.reduce<Record<string, number>>((acc, item) => { const key = String(item.status ?? "unknown"); acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}) });
    }

    if (raw.operation === "financial" && action.includes("calculate")) {
      const amount = typeof fields.amount === "number" ? fields.amount : Number(fields.amount ?? 0);
      const rate = typeof fields.rate === "number" ? fields.rate : 0.1;
      return ok({ amount, tax: Math.round(amount * rate * 100) / 100, total: Math.round(amount * (1 + rate) * 100) / 100 });
    }

    const patch = { ...fields, lastAction: raw.name };
    return ok(store.update(raw.moduleId, record.id, patch), { changed: true, simulated: raw.operation === "message" || action.includes("simulated") });
  };
}

export class ActionRegistry {
  readonly actions: ActionDefinition[];
  private byId = new Map<string, ActionDefinition>();

  constructor() {
    this.actions = createCatalog((raw) => makeHandler(raw));
    for (const action of this.actions) this.byId.set(action.id, action);
    this.assertInvariants();
  }

  assertInvariants(): void {
    if (MODULES.length !== 50) throw new Error(`Catalog must contain 50 modules, found ${MODULES.length}`);
    if (this.actions.length !== 500) throw new Error(`Catalog must contain 500 actions, found ${this.actions.length}`);
    const counts = new Map<string, number>();
    for (const action of this.actions) {
      counts.set(action.moduleId, (counts.get(action.moduleId) ?? 0) + 1);
      if (!action.id || !action.name || !action.handler || !action.inputSchema || !action.outputSchema) throw new Error(`Invalid action definition ${action.id}`);
    }
    for (const module of MODULES) if (counts.get(module.id) !== 10) throw new Error(`${module.id} must have exactly 10 actions`);
  }

  get(actionId: string): ActionDefinition | undefined { return this.byId.get(actionId); }
  all(): ActionDefinition[] { return [...this.actions]; }

  async execute(actionId: string, input: JsonObject, context: { store: StorePort; traceId: string; stepId: string }): Promise<ActionResult> {
    const action = this.byId.get(actionId);
    if (!action) return fail("UNKNOWN_ACTION", `Action ${actionId} is not registered.`);
    for (const [field, schema] of Object.entries(action.inputSchema.fields)) {
      if (schema.required && (input[field] === undefined || input[field] === null || input[field] === "")) return fail("INVALID_INPUT", `${field} is required for ${action.name}.`);
    }
    try {
      if (context.store.consumeInjectedFailure(actionId)) return fail("TOOL_FAILURE", `Simulated tool failure for ${action.name}.`);
      return await action.handler(input, { store: context.store, action, traceId: context.traceId, stepId: context.stepId });
    } catch (error) {
      return fail("HANDLER_ERROR", error instanceof Error ? error.message : "Handler failed.");
    }
  }
}
