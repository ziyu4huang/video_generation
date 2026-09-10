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
 * Harvestable by name since self-arc-22: every dispatch ALSO persists a
 * standard pi-harness run record (`agentName` = --name, default
 * "arc-reviewer") via scripts/lib/arc-run-record.ts, so
 * `reviewer-harvest --name arc-reviewer` finds the verdict through the
 * pi-runs FALLBACK — the same SOP claude-glm named reviewers use. The
 * receipt below remains the arc-loop's own artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadAgentRegistry, spawnSubagent } from "@repo/s2-agent-core-runtime";
import { BUILTIN_PACK_DEFS } from "../src/builtin-pack.js";
import { writeArcReviewRunRecord } from "./lib/arc-run-record.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const promptFile = arg("--prompt-file");
if (!promptFile) {
  console.error("error: --prompt-file <file> is required");
  process.exit(1);
}
// The HARVEST name (self-arc-22): reviewer-harvest --name <this> finds the
// dispatch through the pi-runs record written below.
const harvestName = arg("--name") ?? "arc-reviewer";
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
let resolvedModel: string | undefined;
const result = await spawnSubagent({
  task,
  cwd,
  // Model is DOUBLE-pinned on purpose: the explicit spec here wins outright —
  // "glm-5.3" must never match loosely (it is a substring of "glm-5.3-flash").
  model: "zai/glm-5.3",
  instructions,
  // A reviewer reading a real diff burns turns the same way a planner does.
  maxTurns: 40,
  onModelResolved: (modelId) => {
    resolvedModel = modelId;
  },
});

// Persist the dispatch as a STANDARD pi-runs record (self-arc-22): this is
// what makes reviewer-harvest --name <harvestName> find the verdict — the
// record's agentName is the match key, `output` is the verdict text. Written
// on SUCCESS AND FAILURE, before any exit — a failed review must be
// harvestable as errored, never invisible.
const runId = writeArcReviewRunRecord({
  name: harvestName,
  task,
  model: resolvedModel ?? "zai/glm-5.3",
  cwd,
  startedAt: new Date(t0),
  elapsedMs: Date.now() - t0,
  usage: result.usage,
  turns: result.turns,
  failure: result.failure,
  output: result.output,
});

await mkdir(outDir, { recursive: true });
const receipt = {
  startedAt: new Date(t0).toISOString(),
  finishedAt: new Date().toISOString(),
  elapsedMs: Date.now() - t0,
  cwd,
  agentTypeResolved,
  nameSupported: true,
  name: harvestName,
  runId,
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
