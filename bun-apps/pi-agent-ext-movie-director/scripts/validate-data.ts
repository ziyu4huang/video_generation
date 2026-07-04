/**
 * validate-data.ts — contract check: every bundled pipeline manifest + every
 * bundled JSON schema is loadable + self-consistent. Run via `bun run check:schemas`.
 */
import { listPipelines, loadPipeline } from "../src/pipeline.ts";
import { listSchemas } from "../src/schema.ts";

let failures = 0;

const pipelines = listPipelines();
console.log(`pipelines: ${pipelines.join(", ")}`);
for (const name of pipelines) {
  const m = loadPipeline(name);
  if ("ok" in m && m.ok === false) {
    console.error(`  ✗ ${name}: ${m.errors.join("; ")}`);
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
