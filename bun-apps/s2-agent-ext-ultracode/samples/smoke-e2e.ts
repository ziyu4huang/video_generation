/**
 * smoke-e2e.ts — the REAL end-to-end smoke for dynamic-workflows.
 *
 * Drives the full stack the way a user actually invokes it:
 *   s2-agent CLI  →  -e <engine entry path>  →  the `workflow` TOOL
 *   →  the model calls it with the smoke script  →  background:false inline result.
 *
 * This is the same path as:
 *   bun bun-apps/s2-agent/src/cli.ts -e ultracode -p "<prompt>"
 * …but deterministic: it feeds a FIXED script (default samples/dynamic-workflow-
 * smoke01.js) instead of letting the model invent a 4-phase workflow, so the run
 * takes seconds, not minutes.
 *
 * Contrast with samples/run.ts, which calls runWorkflow() DIRECTLY (library
 * level) — useful and faster, but it bypasses the CLI / argv parsing / the
 * workflow tool, so it is NOT full e2e. This script is.
 *
 * USAGE (from anywhere):
 *   bun bun-apps/s2-agent-ext-ultracode/samples/smoke-e2e.ts [workflow.js]
 *   PI_MODEL=google/gemma-4-12b bun bun-apps/s2-agent-ext-ultracode/samples/smoke-e2e.ts
 *
 * Env:
 *   PI_MODEL       model passed to `--model` (default google/gemma-4-12b; empty
 *                  = default, same as the shell's `${PI_MODEL:-…}`). Use a
 *                  model LM Studio currently has LOADED — a mid-run unload
 *                  ("Model unloaded.") aborts the relay silently (2026-08-25).
 *   S2_PRINT_IDLE_EXIT_MS  inherited by the CLI child: print-mode idle
 *                  watchdog deadline (default 300s; the full relay + 2 child
 *                  agents can exceed it on a cold local model — 900000 is a
 *                  safe value).
 *   SMOKE_E2E_CLI  override the s2-agent CLI path (test-only; default
 *                  bun-apps/s2-agent/src/cli.ts resolved from this file)
 *   SMOKE_E2E_EXT  override the -e extension entry path (test-only; default
 *                  the engine's registered entry resolved from the repo root)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// samples/ -> s2-agent-ext-ultracode/ -> bun-apps/ -> repo root
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const CLI = process.env.SMOKE_E2E_CLI || resolve(REPO_ROOT, "bun-apps/s2-agent/src/cli.ts");

const MODEL = process.env.PI_MODEL || "google/gemma-4-12b";
const WF = process.argv[2] || resolve(SCRIPT_DIR, "dynamic-workflow-smoke01.js");
// The `-e` value MUST be a real path: pi's extension loader treats a bare name
// as a cwd-relative path (broken 2026-08-25 on this repo — `<root>/ultracode`
// does not exist), so resolve the engine's registered entry from the repo
// root, same as CLI below. Override with SMOKE_E2E_EXT (test-only).
const EXT = process.env.SMOKE_E2E_EXT || resolve(REPO_ROOT, "bun-apps/s2-agent-ext-ultracode/extensions/ultracode.ts");
if (!existsSync(EXT)) {
  console.error(`extension entry not found: ${EXT}`);
  process.exit(2);
}

if (!existsSync(WF)) {
  console.error(`workflow file not found: ${WF}`);
  process.exit(2);
}

// `$(cat …)` in the .sh strips the file's trailing newlines — same here.
const WF_SCRIPT = readFileSync(WF, "utf8").replace(/\n+$/, "");

// Strict prompt: force the model to relay the exact script and run it inline
// (background:false) so the result returns in the same turn — no detached run.
const PROMPT = `Call the workflow tool now with background=false and this EXACT script value (do not modify it, do not wrap in fences, do not write your own script):

${WF_SCRIPT}

Return only the workflow result.`;

// One-shot: the CLI's exit code IS our exit code (the .sh `exec`'d the CLI).
process.exit(
  spawnSync("bun", [CLI, "-e", EXT, "--model", MODEL, "-p", PROMPT], {
    stdio: "inherit",
  }).status ?? 1,
);
