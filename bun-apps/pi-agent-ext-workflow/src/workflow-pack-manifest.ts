/**
 * workflow-pack-manifest.ts — the workflow-pack manifest model.
 *
 * A workflow pack is a folder with a `manifest.json` describing "what it is +
 * how to run it" (wayfinder Decision 2: minimal load-bearing). Required:
 * `name`, `description`, `entry`. Optional: `kind`, `engine`, `args`, `model`,
 * `thinking`, `howToRun`. This module is the contract every later phase
 * (resolver, runner, list, examples) reads a pack through — pure, no network.
 *
 * Optional fields are present on a returned `Manifest` ONLY when supplied, so
 * `"key" in manifest` is a sound "was it declared?" check (absent ≠ undefined).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A validated workflow-pack manifest. */
export interface Manifest {
  name: string;
  description: string;
  /** Path to the entry workflow script, relative to the pack dir
   *  (suffix-agnostic — the engine reads script text, not a path). */
  entry: string;
  /** Default args; merged under CLI `--args` (CLI wins, shallow-merge). */
  args?: unknown;
  /** Default model spec; overridden by `--model`. */
  model?: string;
  /** Default thinking level; overridden by `--thinking`. */
  thinking?: string;
  /** Human-facing "how to run it" prose. Not read for execution. */
  howToRun?: string;
  /** Self-identification: "workflow-pack". Lets a pack folder self-describe the
   *  way a pi extension folder does (wayfinder ticket 05 — minimal alignment). */
  kind?: string;
  /** Which engine runs the entry (e.g. "pi-agent-ext-workflow"). Optional self-id. */
  engine?: string;
}

/** Required-field order (also the validation order — name, description, entry). */
const REQUIRED: ReadonlyArray<keyof Manifest> = ["name", "description", "entry"];

/** Injectable fs so the contract test exercises every branch without temp dirs. */
export interface ReadManifestOptions {
  read?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/** Read + validate a pack's `manifest.json`. Throws a clear, prefixed error on
 *  any problem (missing file, bad JSON, missing/empty/wrong-type field). */
export function readManifest(packDir: string, opts: ReadManifestOptions = {}): Manifest {
  const read = opts.read ?? ((p) => readFileSync(p, "utf8"));
  const exists = opts.exists ?? ((p) => existsSync(p));
  const manifestPath = join(packDir, "manifest.json");
  if (!exists(manifestPath)) {
    throw new Error(`manifest: no manifest.json in ${packDir} (not a workflow pack)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(manifestPath));
  } catch (e) {
    throw new Error(`manifest: manifest.json is not valid JSON (${(e as Error).message})`);
  }
  return validateManifest(parsed);
}

/** Validate a parsed manifest value into a typed `Manifest`, or throw naming the
 *  offending field. Pure. */
export function validateManifest(value: unknown): Manifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("manifest: manifest.json must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  for (const key of REQUIRED) {
    const v = obj[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`manifest: required field "${key}" is missing or empty`);
    }
  }
  if (hasBadString(obj, "model")) throw new Error('manifest: optional field "model" must be a string');
  if (hasBadString(obj, "thinking")) throw new Error('manifest: optional field "thinking" must be a string');
  if (hasBadString(obj, "howToRun")) throw new Error('manifest: optional field "howToRun" must be a string');
  if (hasBadString(obj, "kind")) throw new Error('manifest: optional field "kind" must be a string');
  if (hasBadString(obj, "engine")) throw new Error('manifest: optional field "engine" must be a string');
  // args: any JSON value is allowed (Decision 5 — no schema validation in v1).

  const manifest: Manifest = {
    name: obj.name as string,
    description: obj.description as string,
    entry: obj.entry as string,
  };
  if (obj.args !== undefined) manifest.args = obj.args;
  if (obj.model !== undefined) manifest.model = obj.model as string;
  if (obj.thinking !== undefined) manifest.thinking = obj.thinking as string;
  if (obj.howToRun !== undefined) manifest.howToRun = obj.howToRun as string;
  if (obj.kind !== undefined) manifest.kind = obj.kind as string;
  if (obj.engine !== undefined) manifest.engine = obj.engine as string;
  return manifest;
}

/** True when `obj[key]` is present but not a string (absent is allowed). */
function hasBadString(obj: Record<string, unknown>, key: string): boolean {
  return key in obj && obj[key] !== undefined && typeof obj[key] !== "string";
}
