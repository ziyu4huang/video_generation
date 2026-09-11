#!/usr/bin/env bun

/**
 * arc-plan — the hands-on loop's opening move (user directive, 2026-09-07):
 * EVERY new iteration begins by dispatching a PLANNING subagent on GLM 5.3
 * (never flash) through this repo's own spawn machinery — the same
 * `spawnSubagent` path the products use, routed by agentType `hard-problem`
 * (its def pins `model: zai/glm-5.3`). The planner reads the repo; the plan
 * it returns is what the arc executes, through the devops chain.
 *
 * Usage:
 *   bun arc-plan.ts --prompt-file <file> [--out <dir>] [--cwd <dir>]
 *                   [--include-playbook]
 *
 * --include-playbook prepends the loop playbook (.planning/playbook.md — the
 * curated strategy store, selfimprove-playbook t03) to the planner task and
 * records `playbookIncluded` + `playbookSha256` in plan-receipt.json (the
 * label is not the content — the receipt names the bytes).
 *
 * Writes <out>/plan.md (the child's answer verbatim) + plan-receipt.json
 * (model actually used, usage, elapsed, failure if any). Exit 1 on failure.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadAgentRegistry, spawnSubagent } from "@repo/s2-agent-core-runtime";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** D4 (selfimprove-playbook): compose the playbook prepend + its content
 *  hash. Pure so tests can lock the composition and the receipt field
 *  without spawning a planner. */
export function composePlaybookTask(task: string, playbook: string): { task: string; sha256: string } {
  const sha256 = createHash("sha256").update(playbook).digest("hex");
  return {
    task: `# Loop playbook (cite the PB-nn ids you apply — this is the loop's curated strategy store)\n\n${playbook}\n\n---\n\n${task}`,
    sha256,
  };
}

async function main(): Promise<number> {
  const promptFile = arg("--prompt-file");
  if (!promptFile) {
    console.error("error: --prompt-file <file> is required");
    process.exit(1);
  }
  const outDir = resolve(arg("--out") ?? "output/arc-plan");
  const cwd = resolve(arg("--cwd") ?? process.cwd());
  const includePlaybook = process.argv.includes("--include-playbook");

  let task = await Bun.file(promptFile).text();

  // D4 (selfimprove-playbook): read-at-open is mechanical — the playbook is
  // prepended to the planner task and its sha256 lands in the receipt.
  let playbookIncluded = false;
  let playbookSha256: string | null = null;
  const playbookPath = join(cwd, ".planning", "playbook.md");
  if (includePlaybook) {
    if (!existsSync(playbookPath)) {
      console.error(`error: --include-playbook but playbook not found at ${playbookPath}`);
      process.exit(1);
    }
    const composed = composePlaybookTask(task, await readFile(playbookPath, "utf8"));
    task = composed.task;
    playbookSha256 = composed.sha256;
    playbookIncluded = true;
  }

  // agentType binding, tool-layer style: resolve the def from the SAME registry
  // spawn resolves against, and prepend its prompt as the instructions prefix
  // (core spawnSubagent takes instructions, not agentType — the tool layer does
  // exactly this composition).
  const def = loadAgentRegistry(cwd).get("hard-problem");

  const t0 = Date.now();
  const result = await spawnSubagent({
    task,
    cwd,
    // Model is DOUBLE-pinned on purpose: the def says zai/glm-5.3 AND the
    // explicit spec here wins outright — "glm-5.3" must never match loosely
    // (it is a substring of "glm-5.3-flash").
    model: "zai/glm-5.3",
    instructions: def?.prompt,
    // A planner that reads before writing burns turns fast — the first run
    // exhausted 24 turns on repo reading alone (2.1M cache-read tokens, zero
    // output). 40 + an explicit read budget in the prompt keeps it honest.
    maxTurns: 40,
  });

  await mkdir(outDir, { recursive: true });
  const receipt = {
    startedAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    cwd,
    agentType: "hard-problem",
    defResolved: Boolean(def),
    requestedModel: "zai/glm-5.3",
    playbookIncluded,
    playbookSha256,
    failure: result.failure,
    usage: result.usage,
    turns: result.turns,
  };
  await writeFile(join(outDir, "plan.md"), result.output, "utf8");
  await writeFile(join(outDir, "plan-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  if (result.failure) {
    console.error(`[arc-plan] FAIL (${result.failure.kind}) — receipt: ${join(outDir, "plan-receipt.json")}`);
    console.error(result.output.slice(0, 800));
    process.exit(1);
  }
  console.log(
    `[arc-plan] PASS — ${((Date.now() - t0) / 1000).toFixed(0)}s, usage ${JSON.stringify(result.usage ?? {})}${playbookIncluded ? `, playbook ${(playbookSha256 ?? "").slice(0, 12)}` : ""} — plan: ${join(outDir, "plan.md")}`,
  );

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
