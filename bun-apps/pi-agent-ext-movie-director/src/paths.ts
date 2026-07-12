/**
 * paths.ts — resolve the extension's bundled data dir + the project workspace.
 *
 * The extension ships its data (pipeline manifests, JSON schemas, style
 * playbooks, MD skills) under `data/`. Project workspaces (one per video being
 * produced) live under MLX_OUTPUT_DIR/movie-director/projects/<id>/ and hold
 * checkpoints, artifacts, cost logs. Mirrors OpenMontage's `lib/checkpoint.py`
 * project-dir layout + the repo's externalized-output convention.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The extension's own root (this file is src/paths.ts → root is ../). */
export const EXT_ROOT = resolve(import.meta.dirname, "..");

/** Bundled data: manifests, schemas, playbooks, skills. */
export const DATA_DIR = join(EXT_ROOT, "data");

/** Project workspaces root. Override via MLX_OUTPUT_DIR (repo convention). */
export function projectsRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.MLX_OUTPUT_DIR && env.MLX_OUTPUT_DIR.length > 0) {
    return join(env.MLX_OUTPUT_DIR, "movie-director", "projects");
  }
  // Default: sibling-of-repo output store (../video_generation__output).
  return join(homedir(), "video_generation__output", "movie-director", "projects");
}

/** One project's directory. */
export function projectDir(projectId: string, env: Record<string, string | undefined> = process.env): string {
  return join(projectsRoot(env), projectId);
}

/** Checkpoint file path for a stage (matches OpenMontage's checkpoint_<stage>.json). */
export function checkpointPath(projectId: string, stage: string, env?: Record<string, string | undefined>): string {
  return join(projectDir(projectId, env), `checkpoint_${stage}.json`);
}

/** Cost log path for a project. */
export function costLogPath(projectId: string, env?: Record<string, string | undefined>): string {
  return join(projectDir(projectId, env), "cost_log.json");
}

/** Decision log path for a project (append-only provider/model-choice record). */
export function decisionLogPath(projectId: string, env?: Record<string, string | undefined>): string {
  return join(projectDir(projectId, env), "decision_log.json");
}

/** History dir (archived superseded checkpoints). */
export function historyDir(projectId: string, env?: Record<string, string | undefined>): string {
  return join(projectDir(projectId, env), "history");
}
