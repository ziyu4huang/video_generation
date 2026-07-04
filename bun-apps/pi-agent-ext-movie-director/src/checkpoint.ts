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
import { validate } from "./schema.ts";
import { checkpointPath, projectDir, historyDir } from "./paths.ts";
import { getStageHumanApprovalDefault, loadPipeline } from "./pipeline.ts";

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
