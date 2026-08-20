/**
 * pipeline.ts — pipeline manifest loader + accessors.
 *
 * Port of OpenMontage's `lib/pipeline_loader.py`. Loads YAML manifests from
 * data/pipeline_defs/, validates each against the pipeline_manifest schema, and
 * exposes the accessor functions the orchestration layer needs: stage order,
 * per-stage human-approval policy, the next stage, skill path, review focus,
 * and required tools.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DATA_DIR } from "./paths.ts";
import { validate } from "./schema.ts";

const PIPELINE_DIR = join(DATA_DIR, "pipeline_defs");

export interface PipelineStage {
  name: string;
  skill?: string;
  produces?: string[];
  required_artifacts_in?: string[];
  optional_artifacts_in?: string[];
  tools_available?: string[];
  required_tools?: string[];
  optional_tools?: string[];
  preferred_tools?: string[];
  fallback_tools?: string[];
  review_focus?: string[];
  success_criteria?: string[];
  checkpoint_required?: boolean;
  human_approval_default?: boolean;
  sub_stages?: Array<Record<string, unknown>>;
}

export interface PipelineManifest {
  name: string;
  version: string;
  description?: string;
  category?: string;
  stages: PipelineStage[];
  compatible_playbooks?: Record<string, string[]>;
  [k: string]: unknown;
}

export interface PipelineLoadError {
  ok: false;
  pipeline: string;
  errors: string[];
}

const cache = new Map<string, PipelineManifest | PipelineLoadError>();

/** List available pipeline manifest names (file stems in data/pipeline_defs). */
export function listPipelines(): string[] {
  try {
    return readdirSync(PIPELINE_DIR)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.(ya?ml)$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Load + schema-validate a pipeline manifest by name. Cached. */
export function loadPipeline(name: string): PipelineManifest | PipelineLoadError {
  if (cache.has(name)) return cache.get(name)!;
  const file = join(PIPELINE_DIR, `${name}.yaml`);
  if (!existsSync(file)) {
    const err: PipelineLoadError = { ok: false, pipeline: name, errors: [`manifest not found: ${name}`] };
    cache.set(name, err);
    return err;
  }
  const raw = readFileSync(file, "utf8");
  const parsed = parse(raw) as PipelineManifest;
  const v = validate("pipeline/pipeline_manifest", parsed);
  if (!v.ok) {
    const err: PipelineLoadError = { ok: false, pipeline: name, errors: v.errors };
    cache.set(name, err);
    return err;
  }
  cache.set(name, parsed);
  return parsed;
}

/** Stage accessors — all tolerate a failed load by returning a default. */
export function getStageOrder(name: string): string[] {
  const m = loadPipeline(name);
  return "stages" in m ? m.stages.map((s) => s.name) : [];
}

export function getStage(name: string, stage: string): PipelineStage | undefined {
  const m = loadPipeline(name);
  return "stages" in m ? m.stages.find((s) => s.name === stage) : undefined;
}

/** The binding human-approval policy for a stage (default false). */
export function getStageHumanApprovalDefault(name: string, stage: string): boolean {
  return getStage(name, stage)?.human_approval_default ?? false;
}

export function getStageCheckpointRequired(name: string, stage: string): boolean {
  return getStage(name, stage)?.checkpoint_required ?? false;
}

export function getStageProduces(name: string, stage: string): string[] {
  return getStage(name, stage)?.produces ?? [];
}

export function getStageSkill(name: string, stage: string): string | undefined {
  return getStage(name, stage)?.skill;
}

export function getStageReviewFocus(name: string, stage: string): string[] {
  return getStage(name, stage)?.review_focus ?? [];
}

export function getStageTools(name: string, stage: string): string[] {
  const s = getStage(name, stage);
  if (!s) return [];
  return [...(s.tools_available ?? []), ...(s.required_tools ?? []), ...(s.optional_tools ?? [])];
}

/** Name of the stage whose `produces` list includes `artifact`, if any. */
export function findStageProducingArtifact(name: string, artifact: string): string | undefined {
  const m = loadPipeline(name);
  return "stages" in m ? m.stages.find((s) => s.produces?.includes(artifact))?.name : undefined;
}

/** Next stage after `stage`, or undefined if `stage` is the last / unknown. */
export function getNextStage(name: string, stage: string): string | undefined {
  const order = getStageOrder(name);
  const i = order.indexOf(stage);
  if (i < 0 || i + 1 >= order.length) return undefined;
  return order[i + 1];
}
