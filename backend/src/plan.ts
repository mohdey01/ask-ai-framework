import { z } from "zod";
import type { ActionDefinition, JsonObject, PlanOperation, PlanStep } from "./types.js";

const planStepSchema = z.object({
  id: z.string().min(1),
  action: z.string().regex(/^M\d{2}\.A\d{2}$/).optional(),
  op: z.enum(["filter", "exclude", "join", "count", "sort", "limit"]).optional(),
  args: z.record(z.any()).default({}),
  dependsOn: z.array(z.string()).default([]),
  purpose: z.string().optional(),
  from: z.string().optional(),
  against: z.string().optional(),
  field: z.string().optional(),
  equals: z.any().optional(),
  contains: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  descending: z.boolean().optional(),
  forEach: z.string().optional(),
  excludeBy: z.string().optional(),
  excludeField: z.string().optional()
}).refine((step) => Boolean(step.action) !== Boolean(step.op), { message: "Each step must define exactly one action or built-in operation." });

export const planDocumentSchema = z.object({
  intent: z.string().default(""),
  assumptions: z.array(z.string()).default([]),
  clarification: z.string().nullable().default(null),
  unsupported: z.boolean().default(false),
  steps: z.array(planStepSchema).default([])
});

export type PlanDocument = z.infer<typeof planDocumentSchema>;
export type PlanValidation = { document: PlanDocument; plan: PlanStep[]; error?: string };

const normalizedWords = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Repair only an unambiguous, single-step direct intent before validation.
 *
 * Retrieval intentionally gives the model a small candidate set, but a model
 * can still choose a neighbouring action such as "Create product" instead of
 * "Create product price". This guardrail uses the user's exact action phrase
 * and the already-retrieved allowlist; it never invents an action or changes a
 * compound workflow.
 */
export function repairObviousDirectPlan(raw: unknown, message: string, candidates: ActionDefinition[]): unknown {
  const parsed = planDocumentSchema.safeParse(raw);
  if (!parsed.success) return raw;
  if (/\b(and|then|after|unless|while|also|skip|exclude|each|every|per)\b/i.test(message)) return raw;

  const messageWords = new Set(normalizedWords(message));
  const matches = candidates
    .filter((candidate) => ["create", "read", "search"].includes(candidate.operation))
    .map((candidate) => {
      const actionWords = normalizedWords(candidate.name);
      const fullPhraseMatch = actionWords.length > 0 && actionWords.every((word) => messageWords.has(word));
      const singleRecordReadMatch = candidate.operation === "read" && actionWords.length >= 2 && actionWords.slice(0, 2).every((word) => messageWords.has(word));
      return { candidate, fullPhraseMatch, singleRecordReadMatch };
    })
    .filter((match) => match.fullPhraseMatch || match.singleRecordReadMatch)
    .sort((left, right) => Number(right.fullPhraseMatch) - Number(left.fullPhraseMatch) || normalizedWords(right.candidate.name).length - normalizedWords(left.candidate.name).length);
  const target = matches[0]?.candidate;
  if (!target) return raw;

  const currentStep = parsed.data.steps[0];
  const named = message.match(/\b(?:named|called)\s+(.+?)(?:\s+with\s+|\s+for\s+|\s+to\s+|$)/i)?.[1]?.trim();
  const email = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const explicitId = message.match(/\b(M\d{2}-\d{4})\b/i)?.[1]?.toUpperCase();
  const currentArgs = currentStep?.args && typeof currentStep.args === "object" && !Array.isArray(currentStep.args) ? currentStep.args as JsonObject : {};
  const currentFields = currentArgs.fields && typeof currentArgs.fields === "object" && !Array.isArray(currentArgs.fields) ? currentArgs.fields as JsonObject : {};
  const directCreate = target.operation === "create" && target.inputSchema.fields.name?.required && Boolean(named);
  const directRead = target.operation === "read" && Boolean(explicitId);
  if (parsed.data.steps.length > 1 || (!directCreate && !directRead)) return raw;

  const args = directCreate
    ? { ...currentArgs, name: named, fields: { ...currentFields, name: named, ...(email ? { email } : {}) } }
    : { ...currentArgs, id: explicitId };
  return {
    ...parsed.data,
    intent: parsed.data.intent || target.name,
    clarification: null,
    unsupported: false,
    steps: [{ ...(currentStep ?? { id: "direct-intent", dependsOn: [], purpose: `Execute ${target.name}.` }), action: target.id, args }]
  };
}

const refId = (value: string | undefined): string | undefined => value?.replace(/^\$/, "");

/** Validate an LLM plan at the application boundary before any action can run. */
export function validatePlanDocument(raw: unknown, registry: ActionDefinition[], candidates: ActionDefinition[]): PlanValidation {
  const parsed = planDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      document: { intent: "", assumptions: [], clarification: null, unsupported: false, steps: [] },
      plan: [],
      error: parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; ")
    };
  }
  const document = parsed.data;
  if (document.unsupported || document.clarification) return { document, plan: [] };
  const allowed = new Set(candidates.map((action) => action.id));
  const seen = new Set<string>();
  const plan: PlanStep[] = [];
  for (const step of document.steps) {
    if (seen.has(step.id)) return { document, plan: [], error: "Duplicate plan step " + step.id + "." };
    seen.add(step.id);
    const action = step.action ? registry.find((candidate) => candidate.id === step.action) : undefined;
    if (step.action && !action) return { document, plan: [], error: "Unknown action " + step.action + "." };
    if (step.action && !allowed.has(step.action)) return { document, plan: [], error: "Action " + step.action + " was not in the retrieved candidate set." };
    const explicitDependencies = step.dependsOn.map((dependency) => refId(dependency)).filter((dependency): dependency is string => Boolean(dependency));
    const forEachFrom = refId(step.forEach);
    const excludeBy = refId(step.excludeBy);
    const fromStep = refId(step.from);
    const againstStep = refId(step.against);
    const dependencies = [...new Set([...explicitDependencies, ...(fromStep ? [fromStep] : []), ...(againstStep ? [againstStep] : []), ...(forEachFrom ? [forEachFrom] : []), ...(excludeBy ? [excludeBy] : [])])];
    if (dependencies.some((dependency) => !seen.has(dependency))) return { document, plan: [], error: "Step " + step.id + " references an unresolved dependency." };
    if (forEachFrom && !seen.has(forEachFrom)) return { document, plan: [], error: "Step " + step.id + " references an unresolved foreach result." };
    if (excludeBy && !seen.has(excludeBy)) return { document, plan: [], error: "Step " + step.id + " references an unresolved exclusion result." };
    if (fromStep && !seen.has(fromStep)) return { document, plan: [], error: "Step " + step.id + " references an unresolved source result." };
    if (againstStep && !seen.has(againstStep)) return { document, plan: [], error: "Step " + step.id + " references an unresolved comparison result." };
    if (step.op && !fromStep) return { document, plan: [], error: "Built-in operation " + step.op + " must declare a source result." };
    if (step.op === "exclude" && !againstStep) return { document, plan: [], error: "Exclude must declare an against result." };
    const actionId = action?.id ?? `SYS.${step.op?.toUpperCase() ?? "UNKNOWN"}`;
    plan.push({
      stepId: step.id,
      actionId,
      input: step.args as JsonObject,
      dependsOn: dependencies,
      purpose: step.purpose ?? (action ? "Execute " + action.name + "." : "Apply " + step.op + " operation."),
      ...(step.op ? { op: step.op as PlanOperation } : {}),
      ...(fromStep ? { fromStep } : {}),
      ...(againstStep ? { againstStep } : {}),
      ...(step.field ? { field: step.field } : {}),
      ...(step.equals !== undefined ? { equals: step.equals as JsonObject[keyof JsonObject] } : {}),
      ...(step.contains ? { contains: step.contains } : {}),
      ...(step.limit ? { limit: step.limit } : {}),
      ...(step.descending !== undefined ? { descending: step.descending } : {}),
      ...(forEachFrom ? { forEachFrom } : {}),
      ...(excludeBy ? { excludeBy } : {}),
      ...(step.excludeField ? { excludeField: step.excludeField } : {})
    });
  }
  return { document, plan };
}
