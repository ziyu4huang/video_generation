/**
 * self-improve-loop.driver.ts — SYNCHRONOUS direct driver for the flux2
 * self-improve loop.
 *
 * Replaces the old agent-in-the-middle runner path (which backgrounded the
 * workflow and exited before the result — see output/new-goal-20260704-0402.md
 * §0 finding #1). This driver calls the engine's `runWorkflow` DIRECTLY with the
 * workflow source + args, so:
 *   - execution is synchronous (the result is returned, not orphaned);
 *   - no LLM agent sits in the middle to mis-route `background:false`;
 *   - the loop's own per-attempt generate/judge agents still use the REAL model
 *     (they instruct bash to run `flux2 t2i` / `run.py caption`), inheriting the
 *     same on-disk auth/config (`~/.pi/`, models.json) that s2-agent uses — no
 *     manual provider bootstrap.
 *
 * Invoked by run-self-improve-loop.sh, which parses flags + selects a pose via jq
 * and passes the resolved workflow args as `--args '<json>'`.
 *
 * Output: prints `LOOP_RESULT <json>` on the last line (the workflow's structured
 * return) and exits 0 on completion (converged OR needsReview — both are
 * successful runs), non-zero only on a thrown/crashed workflow.
 */
import { runWorkflow } from "../../s2-agent-ext-workflow/src/workflow.js";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

// Register custom LLM providers (lm-studio, …) into pi's ModelRegistry. This is
// an import-SIDE-EFFECT module (it wraps Proto.loadModels at top level), so just
// importing it before any agent session is created makes the same providers
// s2-agent uses available to the workflow's per-attempt bash agents. Without
// this, a bare `bun` driver has no lm-studio provider and the generate/judge
// agents cannot call a model. (Mirrors s2-agent's applyPatches → pre-load-providers.)
// NOTE: as of the pre-load-providers purity fix, the actual monkey-patch lives in
// patches/pre-load-providers.ts — pre-load-providers.ts itself is now a pure
// data/helper module with no import-time side effects.
await import("../../s2-agent/src/patches/pre-load-providers.ts");

/**
 * Deterministic exemplar append — the non-model persistence path (goal 0402
 * criterion #2). The workflow only RETURNS the winning exemplar; this function
 * appends it to the jsonl via plain fs (read → cap by meanFaith → write). It
 * cannot die with a weak-model agent mid-loop. Exported for unit testing.
 */
export function appendExemplar(
  file: string,
  exemplar: Record<string, unknown> | null | undefined,
  maxActive: number,
): { written: boolean; totalLines: number; reason?: string } {
  if (!exemplar || typeof exemplar !== "object") {
    return { written: false, totalLines: 0, reason: "no exemplar" };
  }
  const faithOf = (e: Record<string, unknown>): number =>
    Number((e.verdict as Record<string, unknown> | undefined)?.meanFaith ?? 0);
  let records: Record<string, unknown>[] = [];
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    records = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  }
  records.push(exemplar);
  // Cap: retire lowest-meanFaith entries until <= maxActive.
  if (records.length > maxActive) {
    records.sort((a, b) => faithOf(a) - faithOf(b)); // asc — lowest first
    records = records.slice(records.length - maxActive);
  }
  const dir = path.dirname(file);
  try { mkdirSync(dir, { recursive: true }); } catch { /* may already exist */ }
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(file, content, "utf8");
  return { written: true, totalLines: records.length };
}

/**
 * Load the best cross-run few-shot for a target pose (goal 0402 criterion #3).
 * Reads the exemplars jsonl deterministically (plain fs, not a model agent) and
 * returns the WINNING EXPANDED PROMPT from the highest-meanFaith prior run whose
 * base `prompt` matches the target. Matching is by exact base-prompt string; if
 * none matches, returns "" (first run on this pose → no few-shot). Exported for
 * unit testing.
 */
export function loadFewShot(file: string, targetBasePrompt: string): string {
  if (!targetBasePrompt || !existsSync(file)) return "";
  let records: Record<string, unknown>[] = [];
  try {
    records = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch {
    return "";
  }
  const faithOf = (e: Record<string, unknown>): number =>
    Number((e.verdict as Record<string, unknown> | undefined)?.meanFaith ?? 0);
  const matching = records.filter((e) => String(e.prompt ?? "") === targetBasePrompt);
  if (!matching.length) return "";
  matching.sort((a, b) => faithOf(b) - faithOf(a)); // highest faith first
  return String(matching[0].winningPrompt ?? matching[0].prompt ?? "");
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const WF_PATH = path.join(REPO_ROOT, "bun-apps/s2-agent-ext-flux2/workflows/self-improve-flux2.js");

// Main is guarded by import.meta.main so that IMPORTING this module (e.g. by the
// unit test for appendExemplar) does NOT trigger a real runWorkflow + GPU spend.
async function main() {
  // ── Parse --args '<json>' (+ optional --mock for a no-GPU mechanics check) ──
  let argsJson = "";
  let mock = false;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--args") argsJson = String(process.argv[++i] ?? "{}");
    else if (a === "--mock") mock = true;
  }

  let wfArgs: Record<string, unknown> = {};
  if (argsJson) {
    try {
      const p = JSON.parse(argsJson);
      if (p && typeof p === "object" && !Array.isArray(p)) wfArgs = p as Record<string, unknown>;
    } catch (e) {
      console.error("error: --args is not valid JSON:", String((e as Error).message));
      process.exit(2);
    }
  }
  wfArgs = { repoRoot: REPO_ROOT, ...wfArgs };

  // Cross-run few-shot (criterion #3): if a prior run converged on this pose, load
  // its winning expanded prompt deterministically and seed attempt 0 with it.
  // Target base prompt = first pose's prompt (pose mode) or first prompt (score).
  if (!mock && !wfArgs.fewShot) {
    const poses = wfArgs.poses as Array<{ prompt?: string }> | undefined;
    const prompts = wfArgs.prompts as string[] | undefined;
    const targetBase = (poses && poses[0]?.prompt) || (prompts && prompts[0]) || "";
    if (targetBase) {
      const exemplarFile = path.join(REPO_ROOT, "bun-apps/s2-agent-ext-flux2/workflows/self-improve-flux2.exemplars.jsonl");
      const fewShot = loadFewShot(exemplarFile, targetBase);
      if (fewShot) {
        wfArgs.fewShot = fewShot;
        console.error(`[driver] few-shot: loaded a prior winning prompt for this target (seeding attempt 0)`);
      }
    }
  }

  const source = await Bun.file(WF_PATH).text();
  if (!source) {
    console.error("error: could not read workflow source at " + WF_PATH);
    process.exit(2);
  }

  // Optional no-GPU mechanics check: a mocked agent that fakes generate + judge,
  // proving the driver → runWorkflow → synchronous result path end-to-end.
  const mockAgent = mock
    ? {
        async run(prompt: string) {
          const p = String(prompt ?? "");
          if (/Generate one flux2 t2i PNG/.test(p)) {
            return { ok: true, paths: ["/tmp/wf-loop-driver/p0.png"], binaryReady: true, error: "" };
          }
          if (/Validate this generated pose/.test(p)) {
            return {
              ok: true, path: "/tmp/wf-loop-driver/p0.png", poseId: "MOCK",
              anatomy_pass: true, faithfulness: 0.9,
              anatomy: { limb_count: true, hands: true, face: true, pose_plausible: true },
              atoms: [{ id: "a1", q: "x", present: true, confidence: 0.9 }], issues: [], rawTail: "",
            };
          }
          return null;
        },
      }
    : undefined;

  const t0 = Date.now();
  let result;
  try {
    result = await runWorkflow(source, {
      cwd: REPO_ROOT,
      args: wfArgs,
      persistLogs: true,
      ...(mockAgent ? { agent: mockAgent, agentRetries: 1, persistLogs: false } : {}),
    });
  } catch (e) {
    console.error("workflow crashed:", (e as Error).message);
    console.error((e as Error).stack);
    process.exit(1);
  }

  const r = (result?.result ?? {}) as Record<string, unknown>;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Deterministic (non-model) exemplar persistence — the workflow returns the
  // exemplar; the driver appends it. Only CONVERGED runs are persisted, so the
  // few-shot pool stays clean (a failed run's prompt is not a useful example and
  // would pollute future few-shot selection). Skipped under --mock.
  const exemplarFile = (r.exemplarsFile as string) || path.join(REPO_ROOT, "bun-apps/s2-agent-ext-flux2/workflows/self-improve-flux2.exemplars.jsonl");
  const maxExemplars = Number(r.maxExemplars) || 40;
  const exemplar = r.exemplar as Record<string, unknown> | undefined;
  const isConverged = !!r.converged;
  if (!mock && exemplar && isConverged) {
    try {
      const p = appendExemplar(exemplarFile, exemplar, maxExemplars);
      console.error(`[driver] exemplar ${p.written ? `appended (${p.totalLines} active)` : `NOT written (${p.reason})`} → ${exemplarFile}`);
    } catch (e) {
      console.error(`[driver] WARNING: exemplar append failed: ${(e as Error).message}`);
    }
  }

  // Single parseable marker line — the .sh runner greps this for ok/converged.
  console.log("LOOP_RESULT " + JSON.stringify(r));
  console.error(`[driver] done in ${elapsed}s — ok=${String(r.ok)} converged=${String(r.converged)} attemptsUsed=${r.attemptsUsed}/${r.maxAttempts} needsReview=${String(r.needsReview)}`);

  // Completion (converged OR needsReview) is exit 0; only a crash is non-zero.
  process.exit(0);
}

if (import.meta.main) {
  main();
}
