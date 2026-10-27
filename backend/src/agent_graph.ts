import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { ActionDefinition, JsonObject, PlanStep } from "./types.js";
import { repairObviousDirectPlan, validatePlanDocument, type PlanDocument } from "./plan.js";
import type { LLMProvider, ProviderPlanResult, ProviderUsage } from "./provider.js";

export interface AgentPlanRequest {
  message: string;
  candidates: ActionDefinition[];
  context: JsonObject;
  sessionId?: string;
}

export interface AgentPlanResult {
  plan: PlanStep[];
  document: PlanDocument;
  usage: ProviderUsage;
}

const PlannerState = Annotation.Root({
  request: Annotation<AgentPlanRequest>(),
  generated: Annotation<ProviderPlanResult | null>({
    reducer: (_left, right) => right,
    default: () => null
  }),
  result: Annotation<AgentPlanResult | null>({
    reducer: (_left, right) => right,
    default: () => null
  })
});

/**
 * Small, explicit orchestration graph for the provider-backed planner.
 *
 * LangGraph coordinates planner state transitions; it never receives a store
 * port and therefore cannot mutate domain state. Execution remains in the
 * deterministic registry/executor after this graph returns a validated plan.
 */
export class AgentPlanGraph {
  private readonly graph: ReturnType<typeof this.build>;

  constructor(private readonly provider: LLMProvider, private readonly registry: ActionDefinition[]) {
    this.graph = this.build();
  }

  async invoke(request: AgentPlanRequest): Promise<AgentPlanResult> {
    const state = await this.graph.invoke({ request });
    const result = state.result;
    if (!result) throw new Error("Planner graph completed without a validated result.");
    return result;
  }

  private build() {
    return new StateGraph(PlannerState)
      .addNode("generate", async (state) => ({ generated: await this.provider.generatePlan(state.request) }))
      .addNode("validate", (state) => {
        if (!state.generated) throw new Error("Planner graph has no provider output.");
        const repaired = repairObviousDirectPlan(state.generated.plan, state.request.message, state.request.candidates);
        const validated = validatePlanDocument(repaired, this.registry, state.request.candidates);
        if (validated.error) throw new Error("Planner validation failed: " + validated.error);
        return {
          result: {
            plan: validated.plan,
            document: validated.document,
            usage: state.generated.usage
          }
        };
      })
      .addEdge(START, "generate")
      .addEdge("generate", "validate")
      .addEdge("validate", END)
      .compile();
  }
}
