import type { ActionDefinition, RetrievalHit } from "./types.js";

const tokenize = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);

function score(message: string, action: ActionDefinition): RetrievalHit {
  const tokens = new Set(tokenize(message));
  const reasons: string[] = [];
  let value = 0;
  for (const term of action.searchTerms) {
    if (tokens.has(term)) { value += term.length > 5 ? 3 : 1; reasons.push(term); }
  }
  const phrase = action.name.toLowerCase();
  const normalizedMessage = message.toLowerCase().replace(/\b(a|an|the)\b/g, "").replace(/\s+/g, " ");
  if (message.toLowerCase().includes(phrase) || normalizedMessage.includes(phrase)) { value += 12; reasons.push("exact action phrase"); }
  if (message.toLowerCase().includes(action.moduleName.toLowerCase())) { value += 8; reasons.push("module phrase"); }
  if (action.operation === "search" && /find|search|who|which|list|overdue|quiet|unpaid/.test(message.toLowerCase())) value += 3;
  if (action.operation === "create" && /create|add|make|draft|prepare|set up/.test(message.toLowerCase())) value += 3;
  if (/follow[- ]?up|remind|stay on top|to[- ]?do/.test(message.toLowerCase()) && action.moduleId === "M06") {
    value += 8;
    reasons.push("follow-up task intent");
  }
  return { actionId: action.id, score: value, reasons: [...new Set(reasons)] };
}

export function retrieveActions(message: string, actions: ActionDefinition[], limit = 8): RetrievalHit[] {
  const ranked = actions.map((action) => score(message, action)).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId));
  const moduleCounts = new Map<string, number>();
  const diversified: RetrievalHit[] = [];
  for (const hit of ranked) {
    const moduleId = hit.actionId.slice(0, 3);
    const count = moduleCounts.get(moduleId) ?? 0;
    if (count >= 3) continue;
    moduleCounts.set(moduleId, count + 1);
    diversified.push(hit);
    if (diversified.length >= limit) break;
  }
  if (diversified.length < limit) {
    for (const hit of ranked) {
      if (diversified.some((candidate) => candidate.actionId === hit.actionId)) continue;
      diversified.push(hit);
      if (diversified.length >= limit) break;
    }
  }
  return diversified;
}

export function retrieveBaseline(message: string, actions: ActionDefinition[], limit = 8): RetrievalHit[] {
  return actions.map((action) => score(message, action)).sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId)).slice(0, limit);
}
