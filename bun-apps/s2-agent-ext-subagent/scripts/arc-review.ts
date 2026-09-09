#!/usr/bin/env bun
/**
 * arc-review — the quality gate made symmetric (self-arc-19 t03, user
 * directive 2026-09-10): the REVIEWER dispatched at review time runs the SAME
 * big model as the planner. arc-plan.ts dispatches the PLANNING subagent on
 * GLM 5.3 (never flash); until now the review-side subagent rode the calling
 * harness's builtin flash model. This twin mirrors arc-plan.ts: same
 * `spawnSubagent` path, same double pin, same receipt discipline.
 *
 * Usage:
 *   bun arc-review.ts --prompt-file <file> [--out <dir>] [--cwd <dir>]
 *
 * Writes <out>/review.md (the child's answer verbatim) + review-receipt.json
 * (model actually requested, agentType resolved, usage, elapsed, failure).
 * Exit 1 on failure.
 *
 * Known seam (recorded, not fixed here): core spawnSubagent has NO `name`
 * field and does not persist to the pi-harness run archive, so
 * reviewer-harvest.ts's fallback cannot find this dispatch — the receipt
 * below IS the harvest (review.md is the verdict artifact). Filed as a
 * follow-up gap in the arc map.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadAgentRegistry, spawnSubagent } from "@repo/s2-agent-core-runtime";
import { BUILTIN_PACK_DEFS } from "../src/builtin-pack.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const promptFile = arg("--prompt-file");
if (!promptFile) {
  console.error("error: --prompt-file <file> is required");
  process.exit(1);
}
const outDir = resolve(arg("--out") ?? "output/arc-review");
const cwd = resolve(arg("--cwd") ?? process.cwd());
const task = await Bun.file(promptFile).text();

// Reviewer instructions: prefer the reviewer-typed builtin def (review
// framing: every finding cites file:line + evidence, severity buckets, plain
// "nothing to fix" verdicts). The project registry has no reviewer-typed def
// with a model pin (only `hard-problem`), and the builtin def carries NO
// model pin itself — so the model is pinned HERE, by the explicit spec below
// (the same double-pin discipline arc-plan.ts records).
const reviewerDef = BUILTIN_PACK_DEFS.find((d) => d.name === "code-reviewer");
const projectDef = loadAgentRegistry(cwd).get("hard-problem");
const instructions = reviewerDef?.prompt ?? projectDef?.prompt;
const agentTypeResolved = reviewerDef
  ? "code-reviewer (builtin pack def; no model pin — model pinned by the explicit spec)"
  : "hard-problem (project def; no reviewer-typed def found)";

const t0 = Date.now();
const result = await spawnSubagent({
  task,
  cwd,
  // Model is DOUBLE-pinned on purpose: the explicit spec here wins outright —
  // "glm-5.3" must never match loosely (it is a substring of "glm-5.3-flash").
  model: "zai/glm-5.3",
  instructions,
  // A reviewer reading a real diff burns turns the same way a planner does.
  maxTurns: 40,
});

await mkdir(outDir, { recursive: true });
const receipt = {
  startedAt: new Date(t0).toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedMs: Date.now() - t0,
  cwd,
  agentTypeResolved,
  nameSupported: false,
  requestedModel: "zai/glm-5.3",
  failure: result.failure,
  usage: result.usage,
  turns: result.turns,
};
await writeFile(join(outDir, "review.md"), result.output, "utf8");
await writeFile(join(outDir, "review-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

if (result.failure) {
  console.error(`[arc-review] FAIL (${result.failure.kind}) — receipt: ${join(outDir, "review-receipt.json")}`);
  console.error(result.output.slice(0, 800));
  process.exit(1);
}
console.log(
  `[arc-review] PASS — ${((Date.now() - t0) / 1000).toFixed(0)}s, usage ${JSON.stringify(result.usage ?? {})} — review: ${join(outDir, "review.md")}`,
);
