/**
 * validate-data.ts — contract check: every bundled pipeline manifest + every
 * bundled JSON schema is loadable + self-consistent. Run via `bun run check:schemas`.
 */
import { listPipelines, loadPipeline, type PipelineLoadError } from "../src/pipeline.ts";
import { listSchemas } from "../src/schema.ts";

let failures = 0;

const pipelines = listPipelines();
console.log(`pipelines: ${pipelines.join(", ")}`);
for (const name of pipelines) {
  const m = loadPipeline(name);
  // PipelineManifest's `[k: string]: unknown` index signature means "ok" in m
  // doesn't discriminate the union for TS (m.errors would type as unknown) —
  // the explicit cast is safe since PipelineLoadError.ok is a `false` literal.
  if ("ok" in m && m.ok === false) {
    const err = m as PipelineLoadError;
    console.error(`  ✗ ${name}: ${err.errors.join("; ")}`);
    failures++;
  } else {
    console.log(`  ✓ ${name}`);
  }
}

const schemas = listSchemas();
console.log(`\nschemas compiled: ${schemas.length}`);
for (const k of schemas) console.log(`  • ${k}`);

if (failures > 0) {
  console.error(`\n${failures} pipeline(s) failed validation`);
  process.exit(1);
}
console.log("\nall bundled data valid.");
