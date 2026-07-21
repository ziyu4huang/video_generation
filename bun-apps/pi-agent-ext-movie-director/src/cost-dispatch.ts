/**
 * cost-dispatch.ts — typed prototype of a `cost` tool (tool-design audit,
 * output/next-goal-20260712_142905.md, Item 1/P3).
 *
 * Measures whether converting a self-contained slice of the `movie`
 * dispatcher (the 4 cost-lifecycle commands, which mirror `cost.ts`'s state
 * machine 1:1) into a real TypeBox union pays off vs. the generic
 * `{command, options: Type.Any()}` shape every other `movie` command uses.
 * Additive: `movie`'s own cost-estimate/-reserve/-reconcile/-snapshot
 * subcommands are untouched, so this is cheap to revert (delete this file +
 * extensions/movie-director-cost.ts) if the measurement doesn't pay off.
 */
import { Type, type Static } from "typebox";
import { estimate as costEstimate, reserve as costReserve, reconcile as costReconcile, costSnapshot } from "./cost.ts";
import type { DispatchResult } from "./dispatch.ts";

const CostEstimateParams = Type.Object({
  action: Type.Literal("estimate"),
  projectId: Type.String({ description: "Project id the cost log is scoped to." }),
  tool: Type.String({ description: "Provider/tool name to attribute the cost to, e.g. 'krea2_image'." }),
  operation: Type.String({ description: "Operation label, e.g. 'video_generation:generate'." }),
  estimatedUsd: Type.Number({ description: "Estimated cost in USD." }),
  pipeline: Type.Optional(
    Type.String({
      description:
        "Seeds a brand-new project's budget from that pipeline's orchestration.budget_default_usd. Only applies " +
        "the first time a cost log is created for the project; ignored once one exists.",
    }),
  ),
});

const CostReserveParams = Type.Object({
  action: Type.Literal("reserve"),
  projectId: Type.String({ description: "Project id the cost log is scoped to." }),
  entryId: Type.String({ description: "Entry id returned by action:'estimate'." }),
});

const CostReconcileParams = Type.Object({
  action: Type.Literal("reconcile"),
  projectId: Type.String({ description: "Project id the cost log is scoped to." }),
  entryId: Type.String({ description: "Entry id returned by action:'estimate'." }),
  actualUsd: Type.Number({ description: "Actual cost in USD once the operation settled." }),
  success: Type.Optional(Type.Boolean({ description: "Whether the operation succeeded (default true)." })),
});

const CostSnapshotParams = Type.Object({
  action: Type.Literal("snapshot"),
  projectId: Type.String({ description: "Project id the cost log is scoped to." }),
});

export const CostParams = Type.Union([CostEstimateParams, CostReserveParams, CostReconcileParams, CostSnapshotParams], {
  description: "Cost lifecycle action (estimate → reserve → reconcile) + its own per-action required fields.",
});
export type CostParams = Static<typeof CostParams>;

function jsonOut(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export async function costDispatch(params: CostParams): Promise<DispatchResult> {
  try {
    switch (params.action) {
      case "estimate": {
        const id = costEstimate(params.projectId, params.tool, params.operation, params.estimatedUsd, undefined, params.pipeline);
        return { ok: true, text: jsonOut({ entryId: id }) };
      }
      case "reserve": {
        costReserve(params.projectId, params.entryId);
        return { ok: true, text: jsonOut({ reserved: true }) };
      }
      case "reconcile": {
        costReconcile(params.projectId, params.entryId, params.actualUsd, params.success !== false);
        return { ok: true, text: jsonOut({ reconciled: true }) };
      }
      case "snapshot":
        return { ok: true, text: jsonOut(costSnapshot(params.projectId)) };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
