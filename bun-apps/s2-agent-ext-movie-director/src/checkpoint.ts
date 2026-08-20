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
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validate, hasSchema } from "./schema.ts";
import { checkpointPath, projectDir, historyDir, projectsRoot } from "./paths.ts";
import {
  getStage,
  getStageHumanApprovalDefault,
  getStageCheckpointRequired,
  loadPipeline,
  findStageProducingArtifact,
  getNextStage,
} from "./pipeline.ts";
import { scriptPacingCheck, type ScriptLike } from "./script-pacing-gate.ts";
import type { GateResult } from "./gate.ts";

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
   * Explicit override to complete a stage whose `required_artifacts_in`
   * (other than `final_review`, which has its own dedicated override above)
   * are missing or not yet completed in their producing stage — e.g.
   * `compose` completing without a completed `edit_decisions` from `edit`.
   * Analogous to `overrideFinalReview` — must be passed deliberately.
   */
  overrideRequiredArtifacts?: boolean;
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

  // GATE: every artifact a stage declares in `required_artifacts_in` must
  // actually exist — a completed checkpoint from whichever stage's `produces`
  // lists it, carrying that artifact key. Generalizes what used to be a
  // final_review-only special case (previously the ONLY required_artifacts_in
  // entry enforced in code; `brief`/`script`/`scene_plan`/`asset_manifest`/
  // `edit_decisions`/`render_report` etc. were pure documentation with zero
  // runtime consumer — see the tool-design audit, 2026-07-12). The producing
  // stage is looked up structurally via `findStageProducingArtifact` (never
  // hardcoded to a stage name), so this holds for any pipeline/stage/artifact
  // combination declared in the manifest, not just the shipped ones.
  //
  // `final_review` keeps a STRICTER nested check (verdict must be "pass", not
  // just present) and its own dedicated `overrideFinalReview` escape hatch,
  // preserved for backward compatibility with existing callers/tests. Every
  // other artifact only requires producingCp.status==="completed" plus the
  // artifact key being present; `overrideRequiredArtifacts` bypasses those.
  const requiredArtifacts = getStage(input.pipeline, input.stage)?.required_artifacts_in ?? [];
  if (input.status === "completed" && requiredArtifacts.length > 0) {
    const missing: string[] = [];
    for (const name of requiredArtifacts) {
      const producingStage = findStageProducingArtifact(input.pipeline, name);
      if (!producingStage) continue; // no stage declares producing it — can't verify structurally, skip
      const producingCp = readCheckpointRaw(input.projectId, producingStage, input.env);

      if (name === "final_review") {
        if (input.overrideFinalReview) continue;
        const finalReview = producingCp?.artifacts?.final_review as { verdict?: string } | undefined;
        if (producingCp?.status !== "completed" || finalReview?.verdict !== "pass") {
          missing.push(
            `"final_review" (from "${producingStage}", verdict: ${finalReview?.verdict ?? "missing — stage not completed"}) ` +
              `— pass overrideFinalReview=true to ship past an advisory failure`,
          );
        }
        continue;
      }

      if (input.overrideRequiredArtifacts) continue;
      const present = producingCp?.status === "completed" && producingCp.artifacts != null && name in producingCp.artifacts;
      if (!present) {
        missing.push(`"${name}" (from "${producingStage}", status: ${producingCp?.status ?? "missing — stage not completed"})`);
      }
    }
    if (missing.length > 0) {
      throw new GateViolationError(
        `GATE VIOLATION: stage "${input.stage}" (${input.pipeline}) cannot complete — missing required input ` +
          `artifact(s): ${missing.join("; ")}. Complete the producing stage(s) first, or pass ` +
          `overrideRequiredArtifacts=true (overrideFinalReview=true for the final_review case) only after an ` +
          `explicit human/agent decision to advance without them.`,
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

  // ADVISORY (Bug 3, saturn-young-rings 2026-07-12): whenever this checkpoint
  // carries a `script` artifact, compute its words-per-second pacing and
  // surface the result in metadata — the cheapest possible point to catch
  // "this script only fits its planned duration at an unnaturally fast
  // speaking rate" (which the agent otherwise only discovers after TTS
  // synthesis, and then "fixes" by compressing the narration RATE instead of
  // extending the video). Never blocks the write — see script-pacing-gate.ts's
  // doc-comment for why this stays advisory rather than a hard gate.
  const scriptArtifact = input.artifacts?.script as ScriptLike | undefined;
  const scriptPacing = scriptArtifact && typeof scriptArtifact === "object" ? scriptPacingCheck(scriptArtifact) : undefined;
  const metadata = scriptPacing ? { ...(input.metadata ?? {}), script_pacing: scriptPacing } : input.metadata;

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
    metadata,
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

export interface ProjectSummary {
  projectId: string;
  pipeline?: string;
  latestStage?: string;
  latestStatus?: CheckpointStatus;
  latestTimestamp?: string;
  completedStages: string[];
  /** The stage an agent should resume at: the in-progress/failed/awaiting_human stage itself, or the stage after the latest completed one. */
  resumeStage?: string;
}

/**
 * Discover every project workspace under MLX_OUTPUT_DIR/movie-director/projects/
 * purely from on-disk checkpoint_*.json files — no separate project registry.
 * Closes the resumability gap found in the tool-design audit (2026-07-12):
 * there was previously no way for an agent recovering from a crash to even
 * enumerate what projects/runs it had in flight, since every read-checkpoint-
 * family function requires the caller to already know the exact projectId.
 * Directly ports OpenMontage's `get_next_stage()` resume pattern (walk
 * on-disk checkpoint status, no database) to a "list all projects" surface.
 */
export function listProjects(env: Record<string, string | undefined> = process.env): ProjectSummary[] {
  const root = projectsRoot(env);
  if (!existsSync(root)) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const summaries: ProjectSummary[] = [];
  for (const projectId of dirs) {
    const dir = join(root, projectId);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("checkpoint_") && f.endsWith(".json"));
    } catch {
      continue;
    }
    if (files.length === 0) continue; // no checkpoints written — not a discoverable project yet

    const checkpoints: Checkpoint[] = [];
    for (const f of files) {
      try {
        checkpoints.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as Checkpoint);
      } catch {
        /* skip unreadable/corrupt checkpoint file */
      }
    }
    if (checkpoints.length === 0) continue;

    // "Latest" is determined by PIPELINE STAGE ORDER (via getLatestCheckpoint,
    // which walks the manifest's stage list back-to-front), not by comparing
    // wall-clock timestamps + directory-listing order — readdirSync's order is
    // NOT alphabetical/creation-order-guaranteed across filesystems (macOS's
    // APFS often looks sorted; Linux ext4/tmpfs, as hit in CI, does not), so
    // two checkpoints written in the same millisecond (common under fast
    // synchronous test writes) could tie-break on an arbitrary file order and
    // silently report a stale stage as "latest".
    const pipeline = checkpoints.find((c) => c.pipeline_type)?.pipeline_type;
    const latest = pipeline ? (getLatestCheckpoint(projectId, pipeline, env) ?? checkpoints[0]!) : checkpoints[0]!;
    const completedStages = pipeline
      ? getCompletedStages(projectId, pipeline, env)
      : checkpoints.filter((c) => c.status === "completed").map((c) => c.stage);
    const resumeStage = latest.status === "completed" && pipeline ? getNextStage(pipeline, latest.stage) : latest.stage;

    summaries.push({
      projectId,
      pipeline,
      latestStage: latest.stage,
      latestStatus: latest.status,
      latestTimestamp: latest.timestamp,
      completedStages,
      resumeStage,
    });
  }

  summaries.sort((a, b) => (b.latestTimestamp ?? "").localeCompare(a.latestTimestamp ?? ""));
  return summaries;
}

/**
 * GATE (checkpoint-enforcement gap, placebo-effect-explainer Track A
 * verification run, 2026-07-12): checkpoint_required:true in a pipeline
 * manifest used to be declared policy with zero structural enforcement — an
 * agent could work straight through research→...→assets without ever calling
 * write-checkpoint, and a crash (kernel panics under sustained GPU load in
 * the run that found this) lost the ENTIRE run with no resumable state.
 * Mirrors enforcePreCompose's shape: refuse to report "next" for a
 * checkpoint_required current stage unless a "completed" checkpoint exists
 * for it, unless overrideStageGate:true is passed explicitly. Requires
 * projectId (previously accepted but unused — movie_help already documented
 * it as required). Returns null (proceed) or a `{ok:false}` tool result
 * (blocked) for the caller to return directly.
 */
export function enforceStageCheckpointGate(
  pipeline: string,
  stage: string | undefined,
  projectId: string | undefined,
  opts: { overrideStageGate?: boolean; env?: Record<string, string | undefined> } = {},
): GateResult {
  if (!stage || opts.overrideStageGate || !getStageCheckpointRequired(pipeline, stage)) return null;
  if (!projectId) {
    return {
      ok: false,
      error:
        `next-stage requires non-empty projectId when advancing past stage "${stage}" ` +
        `(checkpoint_required:true in pipeline "${pipeline}") — pass overrideStageGate:true to skip this check.`,
    };
  }
  const cp = readCheckpoint(projectId, stage, opts.env);
  if (cp?.status !== "completed") {
    return {
      ok: false,
      error:
        `GATE VIOLATION: stage "${stage}" (${pipeline}) requires a completed checkpoint before advancing ` +
        `(checkpoint_required:true) — found status: ${cp?.status ?? "missing — write-checkpoint was never called"}. ` +
        `Call write-checkpoint with status="completed" for "${stage}" first, or pass overrideStageGate=true only ` +
        `after an explicit human/agent decision to advance without one.`,
    };
  }
  return null;
}
