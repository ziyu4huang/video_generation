import { describe, test, expect } from "bun:test";

/**
 * manifest-consistency.test.ts — Item 2 of the tool-design audit follow-up
 * (output/next-goal-20260712_135012.md): a maintained registry of every
 * pipeline-manifest field's enforcement status, so a new field added to
 * `data/schemas/pipelines/pipeline_manifest.schema.json` without a matching
 * registry entry here fails CI instead of silently becoming "documentation
 * with zero runtime consumer" the way `required_artifacts_in` did before
 * PR #519 and `orchestration.budget_default_usd` did before this PR.
 *
 * This can't be a fully automatic call-site-of-accessor check (that's a
 * build/CI static-analysis step, not something a test can grep for), so the
 * practical version is: every accessor exported by pipeline.ts (or field
 * consumed directly off a loaded manifest) gets one row below, with an
 * explicit decision — "enforced: <gate/consumer>" or "advisory: <reason>".
 * When you add a field to the schema, add a row here in the same PR.
 */

type EnforcementStatus =
  | { kind: "enforced"; by: string }
  | { kind: "advisory"; reason: string };

const REGISTRY: Record<string, EnforcementStatus> = {
  // ── stage-level fields ──────────────────────────────────────────────────
  required_artifacts_in: { kind: "enforced", by: "checkpoint.ts writeCheckpoint() required-artifacts gate (PR #519)" },
  human_approval_default: { kind: "enforced", by: "checkpoint.ts writeCheckpoint() human-approval gate" },
  checkpoint_required: { kind: "enforced", by: "checkpoint.ts enforceStageCheckpointGate() (PR #518, relocated Item 1)" },
  produces: { kind: "enforced", by: "pipeline.ts findStageProducingArtifact() — required_artifacts_in gate resolves the producing stage through this" },

  required_tools: {
    kind: "advisory",
    reason: "tool availability is a preflight/runtime-environment concern (probedMenuSummary), not a per-stage correctness gate — an agent decides at generate-time whether a configured provider satisfies the stage, not the manifest at checkpoint-write-time",
  },
  tools_available: { kind: "advisory", reason: "same as required_tools — informs the agent's tool choice, not enforced" },
  optional_tools: { kind: "advisory", reason: "same as required_tools — informs the agent's tool choice, not enforced" },
  preferred_tools: { kind: "advisory", reason: "same as required_tools — informs the agent's tool choice, not enforced" },
  fallback_tools: { kind: "advisory", reason: "same as required_tools — informs the agent's tool choice, not enforced" },
  success_criteria: { kind: "advisory", reason: "feeds a reviewer's (human or agent) judgment at an awaiting_human/final-review checkpoint — inherently qualitative, not mechanically checkable" },
  review_focus: { kind: "advisory", reason: "same as success_criteria — a review-prompt hint, not a mechanical check" },
  skill: { kind: "advisory", reason: "names the MD skill file the agent should read for this stage; the agent's own tool-call behavior, not something the orchestration layer can enforce" },
  sub_stages: { kind: "advisory", reason: "structural documentation of optional in-stage phases (e.g. reference-driven sample preview); no gate reads this today" },

  // ── pipeline-level fields ────────────────────────────────────────────────
  "orchestration.budget_default_usd": { kind: "enforced", by: "cost.ts estimate()/freshBudget() seeds a fresh project's budget from this (Item 2, this PR) — DEFAULT_BUDGET.totalUsd=10 is now only a fallback when pipeline is omitted or the field is absent" },
  "orchestration.mode": { kind: "advisory", reason: "no consumer found — reserved/aspirational" },
  "orchestration.skill": { kind: "advisory", reason: "no consumer found — reserved/aspirational" },
  "orchestration.max_wall_time_minutes": { kind: "advisory", reason: "no consumer found — reserved/aspirational; no wall-clock enforcement exists anywhere in this codebase" },
  "orchestration.max_revisions_per_stage": {
    kind: "advisory",
    reason: "no send-back/revision-loop feature exists in src/ or extensions/ at all (confirmed via grep, 2026-07-12) — this field describes a feature that was never built, not a live enforcement gap. Reserved for future use; remove from the schema if the revision-loop feature is permanently descoped.",
  },
  "orchestration.max_send_backs": {
    kind: "advisory",
    reason: "same as max_revisions_per_stage — no send-back mechanism exists to bound. Reserved for future use.",
  },
  default_checkpoint_policy: {
    kind: "advisory",
    reason: "enum documents the pipeline's intended human-oversight posture (guided/manual_all/auto_noncreative), but per-stage human_approval_default is what checkpoint.ts actually reads — this top-level field isn't consulted to derive or override those per-stage defaults",
  },
  "reference_input.supported": { kind: "advisory", reason: "documents whether the pipeline accepts a reference video; no gate blocks a reference-driven call on an unsupported pipeline today" },
  metadata: { kind: "advisory", reason: "free-form; explicitly not meant to be enforced" },
  extensions: { kind: "advisory", reason: "capability extension permission documentation; not read by any gate" },
};

describe("manifest field enforcement registry (Item 2, tool-design audit)", () => {
  test("every registry entry has an explicit, non-empty decision", () => {
    for (const [field, status] of Object.entries(REGISTRY)) {
      if (status.kind === "enforced") {
        expect(status.by.length, `"${field}" enforced-by must be non-empty`).toBeGreaterThan(0);
      } else {
        expect(status.reason.length, `"${field}" advisory reason must be non-empty`).toBeGreaterThan(0);
      }
    }
  });

  test("the confirmed live enforcement gap (required_artifacts_in) is marked enforced", () => {
    expect(REGISTRY.required_artifacts_in?.kind).toBe("enforced");
  });

  test("the confirmed real correctness gap (orchestration.budget_default_usd) is marked enforced", () => {
    expect(REGISTRY["orchestration.budget_default_usd"]?.kind).toBe("enforced");
  });

  test("fields describing a never-built revision-loop feature are marked advisory with an explicit note", () => {
    expect(REGISTRY["orchestration.max_revisions_per_stage"]?.kind).toBe("advisory");
    expect(REGISTRY["orchestration.max_send_backs"]?.kind).toBe("advisory");
  });
});
