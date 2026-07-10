/**
 * checkpoint.ts — gate-enforced checkpoint writer/reader.
 *
 * Port of OpenMontage's `lib/checkpoint.py` (528 lines). The checkpoint is the
 * pipeline's durable state machine: each stage writes a checkpoint_*.json whose
 * status advances pending → in_progress → awaiting_human → completed/failed.
 *
 * The BINDING rule (the gate): writing status="completed" on a stage whose
 * manifest policy is human_approval_default=true is rejected unless
 * human_approved=true is passed. This is the one hard enforcement — it prevents
 * the agent from silently skipping a human approval gate.
 *
 * Atomic writes (temp file → rename) + superseded-checkpoint archival to
 * history/ match the Python original.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { validate, hasSchema } from "./schema.ts";
import { checkpointPath, projectDir, historyDir } from "./paths.ts";
import { getStage, getStageHumanApprovalDefault, loadPipeline, findStageProducingArtifact } from "./pipeline.ts";

export type CheckpointStatus = "pending" | "in_progress" | "awaiting_human" | "completed" | "failed";

export interface CheckpointArtifacts {
  [artifactName: string]: unknown;
}

export interface Checkpoint {
  version: string;
  project_id: string;
  pipeline_type: string;
  stage: string;
  status: CheckpointStatus;
  timestamp: string;
  artifacts: CheckpointArtifacts;
  style_playbook?: string;
  checkpoint_policy?: string;
  human_approval_required?: boolean;
  human_approved?: boolean;
  review?: unknown;
  cost_snapshot?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class GateViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateViolationError";
  }
}

export interface WriteCheckpointInput {
  projectId: string;
  pipeline: string;
  stage: string;
  status: CheckpointStatus;
  artifacts?: CheckpointArtifacts;
  humanApproved?: boolean;
  /**
   * Explicit override to complete a stage that requires `final_review` as an
   * input artifact (e.g. publish) despite that review's verdict being "fail".
   * Analogous to `humanApproved` — must be passed deliberately, never implied.
   */
  overrideFinalReview?: boolean;
  /**
   * Explicit override to complete a stage whose `artifacts` fail their own
   * canonical schema (e.g. a `research_brief` missing required fields).
   * Analogous to `humanApproved`/`overrideFinalReview` — must be passed
   * deliberately, never implied, so a schema-invalid artifact can still ship
   * on purpose but never silently.
   */
  overrideArtifactValidation?: boolean;
  stylePlaybook?: string;
  review?: unknown;
  costSnapshot?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Test-only: inject a fixed timestamp. Production uses Date.now(). */
  now?: () => string;
  env?: Record<string, string | undefined>;
}

function isoNow(fn?: () => string): string {
  return fn ? fn() : new Date().toISOString();
}

/**
 * Write a checkpoint. ENFORCES THE GATE: `status="completed"` on a stage whose
 * manifest `human_approval_default=true` requires `humanApproved=true`, else
 * throws GateViolationError. Atomic write; superseded checkpoint archived to
 * history/. Validates against the checkpoint schema before writing.
 */
export function writeCheckpoint(input: WriteCheckpointInput): Checkpoint {
  const manifest = loadPipeline(input.pipeline);
  if (!("stages" in manifest)) {
    throw new Error(`cannot write checkpoint: pipeline "${input.pipeline}" failed to load`);
  }
  const approvalRequired = getStageHumanApprovalDefault(input.pipeline, input.stage);

  if (input.status === "completed" && approvalRequired && !input.humanApproved) {
    throw new GateViolationError(
      `GATE VIOLATION: stage "${input.stage}" (${input.pipeline}) requires human approval before ` +
        `completion. Write status="awaiting_human" and END YOUR TURN, or pass humanApproved=true only ` +
        `after explicit user approval.`,
    );
  }

  // GATE: a stage that declares final_review as a required input (publish) must
  // not complete while the linked final_review verdict is "fail" — mirrors the
  // human-approval gate above. The verdict is read from the checkpoint of
  // whichever stage's manifest `produces` lists final_review (compose, in both
  // shipped pipelines), never hardcoded to a stage name.
  const requiresFinalReview = getStage(input.pipeline, input.stage)?.required_artifacts_in?.includes("final_review") ?? false;
  if (input.status === "completed" && requiresFinalReview && !input.overrideFinalReview) {
    const producingStage = findStageProducingArtifact(input.pipeline, "final_review");
    const producingCp = producingStage ? readCheckpointRaw(input.projectId, producingStage, input.env) : undefined;
    const finalReview = producingCp?.artifacts?.final_review as { verdict?: string } | undefined;
    if (finalReview?.verdict === "fail") {
      throw new GateViolationError(
        `GATE VIOLATION: stage "${input.stage}" (${input.pipeline}) cannot complete — the final_review ` +
          `verdict from stage "${producingStage}" is "fail". Fix the flagged issue, or pass ` +
          `overrideFinalReview=true only after an explicit human/agent decision to ship past the advisory failure.`,
      );
    }
  }

  // GATE: every artifact carried into a "completed" checkpoint must conform
  // to its own canonical schema (e.g. artifacts.research_brief must satisfy
  // research_brief.schema.json), not just the checkpoint envelope below.
  // `validate-artifact` alone was advisory — an agent could ignore its
  // rejection and write the checkpoint anyway with garbage/placeholder
  // content. This closes that gap. Artifact keys with no matching canonical
  // schema (custom/intermediate artifacts) are skipped, not failed.
  if (input.status === "completed" && !input.overrideArtifactValidation) {
    for (const [name, data] of Object.entries(input.artifacts ?? {})) {
      const schemaKey = `artifact/${name}`;
      if (!hasSchema(schemaKey)) continue;
      const v = validate(schemaKey, data);
      if (!v.ok) {
        throw new GateViolationError(
          `GATE VIOLATION: stage "${input.stage}" (${input.pipeline}) artifact "${name}" fails its schema and ` +
            `cannot complete:\n  ${v.errors.join("\n  ")}\nFix the artifact and retry, or pass ` +
            `overrideArtifactValidation=true only after an explicit human/agent decision to ship past validation.`,
        );
      }
    }
  }

  const cp: Checkpoint = {
    version: "1.0",
    project_id: input.projectId,
    pipeline_type: input.pipeline,
    stage: input.stage,
    status: input.status,
    timestamp: isoNow(input.now),
    artifacts: input.artifacts ?? {},
    human_approval_required: approvalRequired,
    human_approved: input.humanApproved === true ? true : undefined,
    style_playbook: input.stylePlaybook,
    review: input.review,
    cost_snapshot: input.costSnapshot,
    error: input.error,
    metadata: input.metadata,
  };
  // Drop undefined keys for a clean persisted object.
  const clean = Object.fromEntries(Object.entries(cp).filter(([, v]) => v !== undefined)) as Checkpoint;

  const v = validate("checkpoint/checkpoint", clean);
  if (!v.ok) {
    throw new Error(`checkpoint schema validation failed for stage "${input.stage}":\n  ${v.errors.join("\n  ")}`);
  }

  const env = input.env;
  const dir = projectDir(input.projectId, env);
  mkdirSync(dir, { recursive: true });
  const target = checkpointPath(input.projectId, input.stage, env);

  // Archive the superseded checkpoint to history/ (matches OpenMontage's archival).
  if (existsSync(target)) {
    const histDir = historyDir(input.projectId, env);
    mkdirSync(histDir, { recursive: true });
    const prev = readCheckpointRaw(input.projectId, input.stage, env);
    if (prev) {
      const stamp = (prev.timestamp ?? "unknown").replace(/[:.]/g, "-");
      copyFileSync(target, join(histDir, `checkpoint_${input.stage}_${prev.status}_${stamp}.json`));
    }
  }

  // Atomic write: temp file → rename.
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, target);
  return clean;
}

function readCheckpointRaw(projectId: string, stage: string, env?: Record<string, string | undefined>): Checkpoint | undefined {
  const p = checkpointPath(projectId, stage, env);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Checkpoint;
  } catch {
    return undefined;
  }
}

/** Read a stage checkpoint (or undefined if none written yet). */
export function readCheckpoint(
  projectId: string,
  stage: string,
  env?: Record<string, string | undefined>,
): Checkpoint | undefined {
  return readCheckpointRaw(projectId, stage, env);
}

/** The latest checkpoint for a project (highest stage in manifest order with one written). */
export function getLatestCheckpoint(
  projectId: string,
  pipeline: string,
  env?: Record<string, string | undefined>,
): Checkpoint | undefined {
  const order = (loadPipeline(pipeline) as PipelineManifestLike)?.stages?.map((s) => s.name) ?? [];
  for (let i = order.length - 1; i >= 0; i--) {
    const cp = readCheckpointRaw(projectId, order[i]!, env);
    if (cp) return cp;
  }
  return undefined;
}

/** Names of stages with a completed checkpoint, in manifest order. */
export function getCompletedStages(
  projectId: string,
  pipeline: string,
  env?: Record<string, string | undefined>,
): string[] {
  const order = (loadPipeline(pipeline) as PipelineManifestLike)?.stages?.map((s) => s.name) ?? [];
  return order.filter((s) => readCheckpointRaw(projectId, s, env)?.status === "completed");
}

interface PipelineManifestLike {
  stages?: { name: string }[];
}
