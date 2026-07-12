/**
 * `cost` — typed prototype tool for the cost lifecycle (tool-design audit,
 * output/next-goal-20260712_142905.md, Item 1/P3). See src/cost-dispatch.ts
 * for the schema + rationale. Additive alongside `movie`'s own
 * cost-estimate/-reserve/-reconcile/-snapshot subcommands.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CostParams, costDispatch, type CostParams as CostParamsType } from "../src/cost-dispatch.ts";

function makeCostTool() {
  return defineTool({
    name: "cost",
    label: "Movie Director Cost Lifecycle (typed prototype)",
    description:
      "Typed budget-governance lifecycle: action:'estimate' → 'reserve' → 'reconcile', plus 'snapshot'. Each " +
      "action has its own required fields enforced at the tool-call boundary (no movie_help lookup needed). " +
      "Prototype of a per-command typed schema vs. movie's generic {command, options} shape — see src/cost-dispatch.ts.",
    promptSnippet: "Typed cost-lifecycle tool: action:'estimate'|'reserve'|'reconcile'|'snapshot'.",
    parameters: CostParams,
    async execute(_id, params) {
      const res = await costDispatch(params as CostParamsType);
      const text = res.ok ? res.text : `cost errored: ${res.error}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ok: res.ok, error: res.ok ? undefined : res.error },
      };
    },
  });
}

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeCostTool());
};

export default extension;
