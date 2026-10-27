import { RAW_ACTIONS, MODULES } from "../backend/src/catalog.js";
import type { ActionDefinition } from "../backend/src/types.js";

export interface EvaluationScenario {
  id: string;
  category: "direct" | "indirect" | "multi_step" | "follow_up" | "ambiguous" | "unsupported" | "invalid" | "confirmation";
  messages: string[];
  expectedActionIds: string[];
  expectedBehavior: string;
  moduleId?: string;
  expectedParameters?: Record<string, string[]>;
  /** Exact business-action sequence after ignoring SYS.* plan operations. */
  expectedActionSequence?: string[];
  /** Exact response status sequence, including automatic confirmation turns. */
  expectedStatuses?: string[];
  /** Valid status alternatives when confirmation depends on resolved mutation count. */
  acceptableStatusSequences?: string[][];
  expectedFinalState?: string;
  split?: "dev" | "test";
}

const definitionFor = (moduleId: string, predicate: (action: typeof RAW_ACTIONS[number]) => boolean): typeof RAW_ACTIONS[number] | undefined => RAW_ACTIONS.find((action) => action.moduleId === moduleId && predicate(action));

export function buildScenarios(split: "all" | "dev" | "test" = "all"): EvaluationScenario[] {
  const scenarios: EvaluationScenario[] = [];
  for (const module of MODULES) {
    const read = definitionFor(module.id, (action) => /^(Search|List|Get|View|Count|Preview|Check)/.test(action.name));
    const create = definitionFor(module.id, (action) => /^(Create|Draft|Upload|Invite|Enroll|Record)/.test(action.name));
    if (read) {
      const actionId = `${module.id}.A${String(read.actionNumber).padStart(2, "0")}`;
      const id = `${module.id}-0001`;
      // Search/List/Count query is optional; only single-record reads require an id.
      const expected = read.name.startsWith("Get") || read.name.startsWith("View") ? ["id"] : [];
      const prompts = [
        `Please ${read.name.toLowerCase()} in ${module.name.toLowerCase()} using record ${id}`,
        `I need you to ${read.name.toLowerCase()} for the ${module.name.toLowerCase()} workspace, record ${id}`
      ];
      prompts.forEach((prompt, index) => scenarios.push({ id: `SCN-${module.id}-READ-${index + 1}`, category: "direct", messages: [prompt], expectedActionIds: [actionId], expectedActionSequence: [actionId], expectedStatuses: ["completed"], expectedParameters: { [actionId]: expected }, expectedFinalState: "Read-only result matches the seeded store.", expectedBehavior: "Select the requested module action and return a meaningful result.", moduleId: module.id, split: index === 0 ? "dev" : "test" }));
    }
    if (create) {
      const actionId = `${module.id}.A${String(create.actionNumber).padStart(2, "0")}`;
      const prompts = [
        `Please ${create.name.toLowerCase()} named ${module.name} Demo ${module.id}`,
        `We need to ${create.name.toLowerCase()} named ${module.name} Pilot ${module.id} for the ${module.name.toLowerCase()} launch`
      ];
      prompts.forEach((prompt, index) => scenarios.push({ id: `SCN-${module.id}-CREATE-${index + 1}`, category: "direct", messages: [prompt], expectedActionIds: [actionId], expectedActionSequence: [actionId], expectedStatuses: ["completed"], expectedParameters: { [actionId]: ["name"] }, expectedFinalState: "A new record is persisted in the selected module.", expectedBehavior: "Create or record state in the selected module.", moduleId: module.id, split: index === 0 ? "dev" : "test" }));
    }
  }
  scenarios.push(
    { id: "SCN-INDIRECT-001", category: "indirect", messages: ["Help me follow up with leads who have gone quiet, skip anyone with booked appointments, and create follow-up tasks"], expectedActionIds: ["M03.A03", "M21.A03", "M06.A01"], expectedActionSequence: ["M03.A03", "M21.A03", "M06.A01"], expectedStatuses: ["needs_confirmation", "completed"], acceptableStatusSequences: [["completed"], ["needs_confirmation", "completed"]], expectedBehavior: "Search leads and appointments, then create a follow-up task." },
    { id: "SCN-COMPLEX-001", category: "multi_step", messages: ["Find overdue invoices, exclude customers reminded this week, and draft email reminders"], expectedActionIds: ["M28.A10", "M13.A07", "M13.A01"], expectedActionSequence: ["M28.A10", "M13.A07", "M13.A01"], expectedStatuses: ["completed"], expectedBehavior: "Compose dependent invoice and email steps." },
    { id: "SCN-FOLLOWUP-001", category: "follow_up", messages: ["Find quiet leads, skip anyone with booked appointments, and create follow-up tasks", "Make those tasks due tomorrow"], expectedActionIds: ["M06.A06"], expectedActionSequence: ["M03.A03", "M21.A03", "M06.A01", "M06.A06"], expectedStatuses: ["needs_confirmation", "completed", "completed"], acceptableStatusSequences: [["completed", "completed"], ["needs_confirmation", "completed", "completed"]], expectedBehavior: "Reuse task IDs from the first turn and update due dates." },
    { id: "SCN-AMBIGUOUS-001", category: "ambiguous", messages: ["Create a contact"], expectedActionIds: [], expectedActionSequence: [], expectedStatuses: ["needs_clarification"], expectedBehavior: "Ask for the missing contact name." },
    { id: "SCN-UNSUPPORTED-001", category: "unsupported", messages: ["Book me a flight to London"], expectedActionIds: [], expectedActionSequence: [], expectedStatuses: ["unsupported"], expectedBehavior: "Explain that the capability is unsupported without inventing a result." },
    { id: "SCN-CONFIRM-001", category: "confirmation", messages: ["Archive contact M01-0001"], expectedActionIds: ["M01.A05"], expectedActionSequence: ["M01.A05"], expectedStatuses: ["needs_confirmation", "completed"], expectedBehavior: "Require confirmation before mutation." },
    { id: "SCN-TYPO-001", category: "direct", messages: ["Creat a contcat named Typo Fixed"], expectedActionIds: ["M01.A01"], expectedActionSequence: ["M01.A01"], expectedStatuses: ["completed"], expectedBehavior: "Normalize common typos without inventing an action." },
    { id: "SCN-INVALID-001", category: "invalid", messages: ["Get contact M01-9999"], expectedActionIds: ["M01.A02"], expectedActionSequence: ["M01.A02"], expectedStatuses: ["partial"], expectedBehavior: "Return a not-found failure grounded in the store."
    }
  );
  const normalized = scenarios.map((scenario, index) => ({ ...scenario, split: scenario.split ?? (index % 2 === 0 ? "dev" : "test"), expectedParameters: scenario.expectedParameters ?? Object.fromEntries(scenario.expectedActionIds.map((actionId) => [actionId, []])), expectedFinalState: scenario.expectedFinalState ?? (scenario.category === "unsupported" || scenario.category === "ambiguous" ? "No mutation; return the required explanation or clarification." : scenario.category === "confirmation" ? "No mutation before confirmation; persist only after confirmation." : "Trace and final state satisfy the scenario assertion.") }));
  return split === "all" ? normalized : normalized.filter((scenario) => scenario.split === split);
}

export function actionDefinition(actionId: string): ActionDefinition | undefined {
  const raw = RAW_ACTIONS.find((action) => `${action.moduleId}.A${String(action.actionNumber).padStart(2, "0")}` === actionId);
  return raw ? ({ id: actionId, moduleId: raw.moduleId, moduleName: raw.moduleName, name: raw.name } as ActionDefinition) : undefined;
}
