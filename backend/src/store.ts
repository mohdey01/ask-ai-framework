import type { JsonObject, StorePort, StoredRecord } from "./types.js";

const BASE_TIME = "2026-01-01T00:00:00.000Z";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MockStore implements StorePort {
  private records = new Map<string, Map<string, StoredRecord>>();
  private audit: StoredRecord[] = [];
  private sequence = 0;
  private injectedFailures = new Map<string, number>();

  constructor(moduleIds: string[]) {
    for (const moduleId of moduleIds) this.records.set(moduleId, new Map());
    this.reset();
  }

  private timestamp(): string {
    this.sequence += 1;
    return new Date(Date.parse(BASE_TIME) + this.sequence * 1000).toISOString();
  }

  reset(): void {
    this.sequence = 0;
    this.audit = [];
    this.injectedFailures.clear();
    for (const collection of this.records.values()) collection.clear();
    this.seed("M01", { name: "Sarah Chen", email: "sarah@example.com", type: "lead", source: "Facebook", ownerId: "USR-001", score: 72 });
    this.seed("M01", { name: "David Kumar", email: "david@example.com", type: "lead", source: "Website", ownerId: "USR-002", score: 38 });
    this.seed("M02", { name: "Acme Labs", industry: "Software", contactIds: ["M01-0001"] });
    this.seed("M02", { name: "Beta Group", industry: "Services", contactIds: ["M01-0002"] });
    this.seed("M03", { name: "Sarah Chen", email: "sarah@example.com", contactId: "M01-0001", source: "Facebook", status: "new", ownerId: "USR-001", score: 72, createdDate: "2025-12-29" });
    this.seed("M03", { name: "David Kumar", email: "david@example.com", contactId: "M01-0002", source: "Website", status: "qualified", ownerId: "USR-002", score: 38, createdDate: "2025-12-20" });
    this.seed("M06", { name: "Call Sarah", description: "Follow up with Sarah", dueDate: "2026-01-05", ownerId: "USR-001", priority: "high", status: "open", contactId: "M01-0001" });
    this.seed("M11", { name: "Sarah conversation", contactId: "M01-0001", status: "open", lastReplyAt: "2025-12-25", channel: "email" });
    this.seed("M13", { name: "Welcome email", contactId: "M01-0001", subject: "Welcome", status: "received", sentAt: "2025-12-20" });
    this.seed("M13", { name: "Recent invoice reminder", customerId: "M02-0001", subject: "Invoice reminder", status: "sent", sentAt: "2026-01-01" });
    this.seed("M15", { name: "Facebook Leads", status: "active", audience: "Facebook leads" });
    this.seed("M20", { name: "Sales calendar", timezone: "Asia/Calcutta", hostId: "USR-001", durationMinutes: 30, visibility: "public" });
    this.seed("M21", { name: "Sarah demo", contactId: "M01-0001", startsAt: "2026-01-08T10:00:00Z", status: "booked", hostId: "USR-001" });
    this.seed("M28", { name: "Invoice ACME-1001", customerId: "M02-0001", amount: 1250, balance: 1250, dueDate: "2025-12-10", status: "overdue" });
    this.seed("M28", { name: "Invoice ACME-1002", customerId: "M02-0001", amount: 500, balance: 500, dueDate: "2026-02-01", status: "draft" });
    this.seed("M28", { name: "Invoice BETA-1003", customerId: "M02-0002", amount: 700, balance: 700, dueDate: "2025-12-12", status: "overdue" });
    this.seed("M27", { name: "Accepted ACME quote", customerId: "M02-0001", total: 500, status: "accepted" });
    this.seed("M29", { name: "Payment request ACME-1001", invoiceId: "M28-0001", amount: 1250, status: "unpaid" });
    this.seed("M47", { name: "Cannot log in", contactId: "M01-0002", status: "open", priority: "normal" });
    this.seed("M48", { name: "Aisha Patel", email: "aisha@example.com", role: "sales", status: "active" });
    this.seed("M48", { name: "Miguel Santos", email: "miguel@example.com", role: "sales", status: "active" });
    this.seed("M49", { name: "Sales team", memberIds: ["M48-0001", "M48-0002"], managerId: "M48-0001", strategy: "round_robin" });
    for (const moduleId of this.records.keys()) {
      if ((this.records.get(moduleId)?.size ?? 0) === 0) this.seed(moduleId, { name: `${moduleId} sample record`, status: "active" });
    }
  }

  private seed(moduleId: string, fields: JsonObject): StoredRecord {
    const collection = this.records.get(moduleId);
    if (!collection) throw new Error(`Unknown module ${moduleId}`);
    const id = `${moduleId}-${String(collection.size + 1).padStart(4, "0")}`;
    const now = this.timestamp();
    const record: StoredRecord = { id, moduleId, createdAt: now, updatedAt: now, ...clone(fields) };
    collection.set(id, record);
    return record;
  }

  list(moduleId: string): StoredRecord[] {
    return [...(this.records.get(moduleId)?.values() ?? [])].filter((record) => !record.archived).map(clone);
  }

  get(moduleId: string, id: string): StoredRecord | undefined {
    const record = this.records.get(moduleId)?.get(id);
    return record && !record.archived ? clone(record) : undefined;
  }

  create(moduleId: string, fields: JsonObject): StoredRecord {
    const collection = this.records.get(moduleId);
    if (!collection) throw new Error(`Unknown module ${moduleId}`);
    const id = `${moduleId}-${String(collection.size + 1).padStart(4, "0")}`;
    const now = this.timestamp();
    const record: StoredRecord = { id, moduleId, createdAt: now, updatedAt: now, status: "active", ...clone(fields) };
    collection.set(id, record);
    this.recordMutation({ id: `AUD-${this.sequence}`, moduleId: "AUDIT", event: "create", recordId: id, createdAt: now, updatedAt: now });
    return clone(record);
  }

  update(moduleId: string, id: string, fields: JsonObject): StoredRecord {
    const collection = this.records.get(moduleId);
    const current = collection?.get(id);
    if (!current || current.archived) throw new Error(`Record ${id} was not found in ${moduleId}`);
    const updatedAt = this.timestamp();
    const updated: StoredRecord = { ...current, ...clone(fields), id: current.id, moduleId: current.moduleId, createdAt: current.createdAt, updatedAt };
    collection?.set(id, updated);
    this.recordMutation({ id: `AUD-${this.sequence}`, moduleId: "AUDIT", event: "update", recordId: id, createdAt: updatedAt, updatedAt });
    return clone(updated);
  }

  remove(moduleId: string, id: string, archive: boolean): StoredRecord {
    const collection = this.records.get(moduleId);
    const current = collection?.get(id);
    if (!current || current.archived) throw new Error(`Record ${id} was not found in ${moduleId}`);
    const updatedAt = this.timestamp();
    if (archive) {
      const updated = { ...current, archived: true, status: "archived", updatedAt };
      collection?.set(id, updated);
      this.recordMutation({ id: `AUD-${this.sequence}`, moduleId: "AUDIT", event: "archive", recordId: id, createdAt: updatedAt, updatedAt });
      return clone(updated);
    }
    collection?.delete(id);
    const deleted = { ...current, status: "deleted", updatedAt };
    this.recordMutation({ id: `AUD-${this.sequence}`, moduleId: "AUDIT", event: "delete", recordId: id, createdAt: updatedAt, updatedAt });
    return clone(deleted);
  }

  recordMutation(entry: JsonObject): void {
    const now = this.timestamp();
    this.audit.push({ id: String(entry.id ?? `AUD-${this.sequence}`), moduleId: "AUDIT", createdAt: now, updatedAt: now, ...clone(entry) });
  }

  history(): StoredRecord[] { return clone(this.audit); }

  failNext(actionId: string, count = 1): void { this.injectedFailures.set(actionId, (this.injectedFailures.get(actionId) ?? 0) + count); }

  consumeInjectedFailure(actionId: string): boolean {
    const remaining = this.injectedFailures.get(actionId) ?? 0;
    if (remaining < 1) return false;
    if (remaining === 1) this.injectedFailures.delete(actionId); else this.injectedFailures.set(actionId, remaining - 1);
    return true;
  }
}
