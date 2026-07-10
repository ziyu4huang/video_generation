/**
 * schema.ts — JSON-Schema validation for pipeline manifests, checkpoints, and
 * the canonical artifacts. Schemas are copied verbatim from OpenMontage (MIT)
 * under data/schemas/ and loaded at runtime via ajv.
 *
 * Port of OpenMontage's `lib/pipeline_loader.py` (YAML + jsonschema validate)
 * + `lib/checkpoint.py`'s schema gate.
 */
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

export type ValidateFn = (data: unknown) => boolean;

const compiled = new Map<string, ValidateFn>();

function loadSchemaDir(dir: string, prefix: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (!f.endsWith(".schema.json")) continue;
    const raw = readFileSync(join(dir, f), "utf8");
    const schema = JSON.parse(raw);
    const key = `${prefix}/${f.replace(/\.schema\.json$/, "")}`;
    compiled.set(key, ajv.compile(schema) as ValidateFn);
  }
}

/** Eagerly compile every bundled schema. Idempotent. */
export function loadAllSchemas(): void {
  if (compiled.size > 0) return;
  loadSchemaDir(join(DATA_DIR, "schemas", "pipelines"), "pipeline");
  loadSchemaDir(join(DATA_DIR, "schemas", "checkpoints"), "checkpoint");
  // Artifacts: one validator per artifact file name.
  const artDir = join(DATA_DIR, "schemas", "artifacts");
  let entries: string[] = [];
  try {
    entries = readdirSync(artDir);
  } catch {
    entries = [];
  }
  for (const f of entries) {
    if (!f.endsWith(".schema.json")) continue;
    const raw = readFileSync(join(artDir, f), "utf8");
    const schema = JSON.parse(raw);
    const name = f.replace(/\.schema\.json$/, "");
    compiled.set(`artifact/${name}`, ajv.compile(schema) as ValidateFn);
  }
}

export interface SchemaError {
  ok: false;
  errors: string[];
}

/** Validate `data` against the named schema. Returns {ok} or {ok:false, errors[]}. */
export function validate(schemaKey: string, data: unknown): { ok: true } | SchemaError {
  loadAllSchemas();
  const fn = compiled.get(schemaKey);
  if (!fn) return { ok: false, errors: [`unknown schema "${schemaKey}"`] };
  if (fn(data)) return { ok: true };
  // ajv stores errors on the validate function object.
  const errs = (fn as any).errors ?? [];
  return { ok: false, errors: errs.map((e: any) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`) };
}

/** Validate an artifact of the given canonical name (e.g. "script", "edit_decisions"). */
export function validateArtifact(name: string, data: unknown): { ok: true } | SchemaError {
  return validate(`artifact/${name}`, data);
}

export function listSchemas(): string[] {
  loadAllSchemas();
  return [...compiled.keys()].sort();
}
