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

const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
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

/**
 * Describe what a schema node actually requires, so a caller fixing a
 * validation error doesn't have to guess enum values or nested object shapes
 * from the field name alone.
 */
function describeSchemaNode(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node.enum)) return ` (allowed: ${node.enum.join(", ")})`;
  if (node.type === "object" && Array.isArray(node.required) && node.required.length > 0) {
    return ` (needs: ${node.required.join(", ")})`;
  }
  if (node.type === "array" && node.items?.type === "object" && Array.isArray(node.items.required) && node.items.required.length > 0) {
    return ` (array of objects, each needing: ${node.items.required.join(", ")})`;
  }
  return "";
}

/** Turn one ajv error into an actionable message — name the allowed enum values or the missing nested fields instead of ajv's generic wording. */
function describeAjvError(e: any): string {
  const base = `${e.instancePath || "/"}: ${e.message ?? "invalid"}`;
  if (e.keyword === "enum" && Array.isArray(e.params?.allowedValues)) {
    return `${base} [${e.params.allowedValues.join(", ")}] (got ${JSON.stringify(e.data)})`;
  }
  if (e.keyword === "required" && e.params?.missingProperty) {
    const propSchema = e.parentSchema?.properties?.[e.params.missingProperty];
    return `${base}${describeSchemaNode(propSchema)}`;
  }
  return base;
}

/** Validate `data` against the named schema. Returns {ok} or {ok:false, errors[]}. */
export function validate(schemaKey: string, data: unknown): { ok: true } | SchemaError {
  loadAllSchemas();
  const fn = compiled.get(schemaKey);
  if (!fn) return { ok: false, errors: [`unknown schema "${schemaKey}"`] };
  if (fn(data)) return { ok: true };
  // ajv stores errors on the validate function object.
  const errs = (fn as any).errors ?? [];
  return { ok: false, errors: errs.map(describeAjvError) };
}

/** Validate an artifact of the given canonical name (e.g. "script", "edit_decisions"). */
export function validateArtifact(name: string, data: unknown): { ok: true } | SchemaError {
  return validate(`artifact/${name}`, data);
}

export function listSchemas(): string[] {
  loadAllSchemas();
  return [...compiled.keys()].sort();
}

/** Whether a compiled schema exists for the given key (e.g. "artifact/research_brief"). */
export function hasSchema(schemaKey: string): boolean {
  loadAllSchemas();
  return compiled.has(schemaKey);
}
