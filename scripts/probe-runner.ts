#!/usr/bin/env bun
/**
 * Probe runner — the behavioral-probe harness dispatcher.
 *
 * Loads a probe module, dispatches each probe as an isolated subagent (so the
 * probe sees the target config — the live `subagent` tool schema under test),
 * captures the child's output, runs structural regexes locally, then dispatches
 * a judge subagent that scores the output against the rubric.
 *
 * Usage:
 *   bun scripts/probe-runner.ts <probe-module.ts>                  # run, print table
 *   bun scripts/probe-runner.ts <probe-module.ts> --record <out>   # run, write baseline
 *   bun scripts/probe-runner.ts <probe-module.ts> --baseline <in>  # run, diff vs baseline
 *
 * Runtime model: standalone `bun` invocation. `spawnSubagent` boots a fresh
 * in-memory pi session per dispatch (createAgentSession + real SettingsManager
 * + ~/.pi/auth.json), so it does NOT require a live pi TUI around it. The
 * `subagent` tool is a STATIC extension (not in src/run-dir/manifest.extensions),
 * so the child would NOT auto-load it — we bridge it explicitly via
 * `extensionTools` (exactly what a live session does via
 * pi.getAllToolDefinitions() on session_start). That keeps the probe faithful:
 * the child sees the current on-disk `subagentToolSchema` (fat now, slim later).
 *
 * The Probe/ProbeResult/passed() contract lives in probes/types.ts and is
 * unchanged by any dispatch-mechanism swap (a future workflow-tool-backed
 * runner would reuse the same types + judge-prompt builder).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "../bun-apps/s2-agent-ext-subagent/src/index.ts";
import { type SpawnSubagentResult, spawnSubagent } from "../bun-apps/s2-agent-ext-subagent/src/spawn-subagent.ts";
import { SKILL_EXCLUDE_ENV } from "../bun-apps/s2-agent-ext-superpowers/src/superpowers.ts";
import type { Probe, ProbeResult } from "../.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts";
import { passed } from "../.planning/2026-07-25-simplify-ext-prompt-weight/probes/types.ts";
import {
  alignScores,
  buildJudgePrompt,
  formatRow,
  parseJudgeResult,
  runStructural,
  validateProbe,
} from "../.planning/2026-07-25-simplify-ext-prompt-weight/probes/runner-lib.ts";

// Per-dispatch toolset: the probe must be able to invoke `subagent`, but stays
// non-destructive (no edit/write). The bridged subagent tool is added via
// extensionTools below so it survives the child's tool-policy filter.
const PROBE_TOOLS = ["subagent", "read", "bash", "grep", "find"];
const PROBE_EXCLUDE_TOOLS = ["edit", "write"];

// Bound a single dispatch so a stuck/slow child under load can't hang the whole
// baseline recording. Transient (timeout) failures are surfaced in the result.
const PER_DISPATCH_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 240_000);

// --- `--mode pi` subprocess dispatch (Phase-3 skill-unload audit) -------------
//
// Phase-3 A/B-tests whether the LLM still behaves well when a Superpowers skill
// is UNREGISTERED. The in-process `spawnSubagent` path boots a child via
// createAgentSession, which does NOT load this repo's skills (they load via the
// dev-bootstrap `load-run-dir-resources` patch, only present in a real `pi`
// invocation). So fat-vs-thin children are behaviorally identical on that path.
// Subprocess mode runs a REAL `pi -p`, which loads repo skills AND honors the
// PI_SUPERPOWERS_SKILL_EXCLUDE knob.
//
// Why `-ns` is mandatory in pi mode: the run-dir resolver splices
// `--skill <skillsDir>` into argv, which loads every skill BEFORE this
// extension's `resources_discover` runs (silently deduped to the same real
// files), defeating the exclude knob. `-ns`/`--no-skills` suppresses that splice
// (src/run-dir/resolve.ts `suppressResolvedArgv`), making the extension the SOLE
// skill source so the knob is authoritative. Both fat and thin use `-ns` so the
// ONLY variable between them is the exclude env.
const REPO_ROOT = resolve(import.meta.dir, "..");
const PI_CLI_TS = join(REPO_ROOT, "bun-apps", "s2-agent", "src", "cli.ts");
const PI_MODE_TIMEOUT_MS = Number(process.env.PROBE_PI_TIMEOUT_MS ?? 300_000);

// JSON Schema the judge must return (typebox → TSchema, what spawnSubagent expects).
const judgeSchema = Type.Object({
  scores: Type.Array(Type.Number()),
  notes: Type.String(),
});

/**
 * The bridged `subagent` tool definition handed to every child. Built once.
 * Its `getExtensionTools`/`getMainModel` holders stay empty in standalone mode
 * (no parent session captured them) — that only affects GRANDCHILD dispatch,
 * which the probe rubrics don't depend on (we judge the child's DECISION to
 * dispatch + the self-containedness of its task, not the grandchild's outcome).
 */
function buildBridgedSubagentTool(cwd: string): ToolDefinition {
  return createSubagentTool({ cwd }) as unknown as ToolDefinition;
}

interface DispatchOptions {
  task: string;
  schema?: ReturnType<typeof Type.Object>;
}

/** Send a prompt to an isolated child agent that has `subagent` available; return its output. */
async function dispatchSubagent(
  bridgedTool: ToolDefinition,
  opts: DispatchOptions,
): Promise<SpawnSubagentResult & { toolCalls: string[] }> {
  // Capture the child's tool-call transcript so the structural check can match
  // on actual tool invocations (e.g. "the child called `subagent`"), not just on
  // whether the literal word appeared in its prose summary — a child that
  // dispatches via tool-call but reports "I delegated to a worker…" would
  // otherwise false-fail a /\bsubagent\b/i prose regex.
  let toolCalls: string[] = [];
  const result = await spawnSubagent({
    task: opts.task,
    tools: PROBE_TOOLS,
    excludeTools: PROBE_EXCLUDE_TOOLS,
    schema: opts.schema,
    extensionTools: [bridgedTool],
    timeoutMs: PER_DISPATCH_TIMEOUT_MS,
    retryOnTransient: true,
    onHistory: (history: Array<{ kind: string; toolName?: string }>) => {
      toolCalls = history
        .filter((h) => h.kind === "toolCall")
        .map((h) => h.toolName ?? "tool");
    },
  });
  return { ...result, toolCalls };
}

/** Uniform dispatch outcome across modes (subagent | pi). */
interface ProbeDispatchOutput {
  output: string;
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  /** Tool-call trace (subagent mode only; empty under `--mode pi`). */
  toolCalls: string[];
}

/** A per-probe dispatch strategy. The judge always uses the subagent path. */
type ProbeDispatcher = (task: string) => Promise<ProbeDispatchOutput>;

interface PiDispatchOptions {
  /** Extra env merged onto process.env for the child. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Pass `-ns` so the extension is the SOLE skill source (default true).
   *  See the block comment above PI_MODE_TIMEOUT_MS for why this is mandatory
   *  for the exclude knob to take effect. */
  noSkills?: boolean;
}

/**
 * Run a probe via a REAL `pi -p` subprocess (Phase-3). `pi` loads repo skills
 * + honors PI_SUPERPOWERS_SKILL_EXCLUDE, so a fat/thin pair (no-env vs env) is
 * behaviorally distinct. Captures stdout; non-zero exit + timeout are surfaced
 * in the result (not thrown) so the run completes and the table still prints.
 * No tool-call transcript is available from `-p` mode (`toolCalls: []`), so
 * Phase-3 probe `structural` regexes must be behavior/prose-oriented and the
 * judge carries the main signal.
 */
async function dispatchPi(prompt: string, opts: PiDispatchOptions = {}): Promise<ProbeDispatchOutput> {
  const noSkills = opts.noSkills ?? true;
  const cmd: string[] = ["bun", PI_CLI_TS, "-p", prompt];
  if (noSkills) cmd.push("-ns");
  const child = Bun.spawn({
    cmd,
    cwd: REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = opts.timeoutMs ?? PI_MODE_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited — nothing to kill
    }
  }, timeoutMs);
  try {
    // Drain stdout + stderr concurrently (avoids pipe deadlock on a chatty
    // child), then await exit. A SIGKILL on timeout rejects/short-circuits the
    // stdout read; we still resolve with whatever was buffered.
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output: stdout.trim(), exitCode, stderr: stderr.trim(), timedOut, toolCalls: [] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: "", exitCode: -1, stderr: `[probe-runner] dispatchPi threw: ${msg}`, timedOut, toolCalls: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Build the probe dispatcher for `--mode pi`, binding a fixed env (fat={} / thin). */
function piDispatcher(env: Record<string, string>): ProbeDispatcher {
  return (task) => dispatchPi(task, { env });
}

/** Run one probe end-to-end: dispatch → structural → judge. Never throws (records failures).
 *  `probeDispatch` is the per-mode probe dispatch (subagent | pi); the judge
 *  always runs on the in-process subagent path (a neutral grader that doesn't
 *  need skills, so it stays consistent across fat/thin runs). */
async function runProbe(
  bridgedTool: ToolDefinition,
  p: Probe,
  probeDispatch: ProbeDispatcher,
): Promise<ProbeResult> {
  const problems = validateProbe(p);
  if (problems.length) {
    return {
      id: p.id,
      rubricScores: [],
      structuralPassed: false,
      judgeNotes: `invalid probe fixture: ${problems.join("; ")}`,
      output: "",
    };
  }

  // 1. Dispatch the probe; capture its output + tool calls (tool calls empty
  //    under `--mode pi` — no transcript from `-p`).
  const probeRes = await probeDispatch(p.prompt);
  const out =
    probeRes.output ||
    (probeRes.exitCode !== 0 ? `[dispatch failed exit=${probeRes.exitCode}] ${probeRes.stderr}` : "");

  // 2. Structural checks (local, deterministic) — match against the prose
  //    output AND the tool-call trace, so a regex like /\bsubagent\b/ fires on
  //    an actual `subagent` tool invocation even if the prose never names it.
  const callTrace = probeRes.toolCalls.length ? `\n[tools called: ${probeRes.toolCalls.join(", ")}]` : "";
  const structuralPassed = runStructural(p.structural, out + callTrace);

  // 3. Judge: a second subagent scores the output vs the rubric (0–3 each).
  const judgeRes = await dispatchSubagent(bridgedTool, { task: buildJudgePrompt(p.rubric, out), schema: judgeSchema });
  const judgedRaw = judgeRes.output || "";
  const { scores, notes } = parseJudgeResult(judgedRaw);

  const dispatchNote =
    probeRes.timedOut || probeRes.exitCode !== 0
      ? ` [probe-dispatch: ${probeRes.timedOut ? "TIMEOUT" : `exit ${probeRes.exitCode}`}]`
      : "";
  const judgeNote =
    judgeRes.timedOut || judgeRes.exitCode !== 0
      ? ` [judge-dispatch: ${judgeRes.timedOut ? "TIMEOUT" : `exit ${judgeRes.exitCode}`}]`
      : "";

  return {
    id: p.id,
    rubricScores: alignScores(scores, p.rubric.length),
    structuralPassed,
    judgeNotes: (notes + dispatchNote + judgeNote).trim(),
    output: out,
  };
}

function loadBaseline(path: string): ProbeResult[] | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProbeResult[];
  } catch {
    console.warn(`[probe-runner] could not read baseline ${path}; treating as no baseline`);
    return undefined;
  }
}

function baselineFor(id: string, baseline: ProbeResult[] | undefined): ProbeResult | undefined {
  return baseline?.find((b) => b.id === id);
}

/** Read a `--flag <value>` pair from a flags slice; returns undefined if absent. */
function flagValue(flags: string[], name: string): string | undefined {
  const idx = flags.indexOf(name);
  return idx >= 0 ? flags[idx + 1] : undefined;
}

type ProbeMode = "subagent" | "pi";

/** One probe's fat-vs-thin A/B outcome (Phase-3 skill-unload audit). */
interface AbResult {
  id: string;
  fat: ProbeResult;
  thin: ProbeResult;
}

/** Per-probe A/B delta line: fat scores → thin scores, structural, verdict. */
function formatAbRow(ab: AbResult, rubricLength: number): string {
  const fat = alignScores(ab.fat.rubricScores, rubricLength);
  const thin = alignScores(ab.thin.rubricScores, rubricLength);
  const delta = thin.map((s, i) => s - fat[i]);
  const verdict = passed(ab.thin, ab.fat) ? "PASS" : "REGRESSION";
  const fatStr = fat.join(",");
  const thinStr = thin.join(",");
  const deltaStr = delta.map((d) => (d >= 0 ? `+${d}` : `${d}`)).join(",");
  const struct = ab.thin.structuralPassed ? "struct:ok" : "struct:FAIL";
  return `${ab.id.padEnd(34)} fat=[${fatStr}] thin=[${thinStr}] Δ=[${deltaStr}] ${struct} ${verdict}`;
}

async function main() {
  const probeModule = process.argv[2];
  if (!probeModule) {
    console.error(
      "Usage: bun scripts/probe-runner.ts <probe-module.ts>\n" +
        "         [--mode subagent|pi] [--record <out> | --baseline <in>]\n" +
        "         [--ab-skill <name>]   # Phase-3 fat-vs-thin A/B (implies --mode pi)",
    );
    process.exit(2);
  }

  const flags = process.argv.slice(3);
  const recordPath = flagValue(flags, "--record");
  const baselinePath = flagValue(flags, "--baseline");
  const modeRaw = flagValue(flags, "--mode") as ProbeMode | undefined;
  const abSkill = flagValue(flags, "--ab-skill");
  if (recordPath && baselinePath) {
    console.error("error: --record and --baseline are mutually exclusive");
    process.exit(2);
  }
  if (modeRaw && modeRaw !== "subagent" && modeRaw !== "pi") {
    console.error(`error: --mode must be subagent|pi (got ${modeRaw})`);
    process.exit(2);
  }
  // --ab-skill only makes sense in pi mode: createAgentSession (subagent path)
  // never loads repo skills, so fat/thin would be behaviorally identical there.
  const mode: ProbeMode = abSkill ? "pi" : modeRaw ?? "subagent";
  if (abSkill && modeRaw === "subagent") {
    console.error("error: --ab-skill requires skill loading, which only --mode pi provides");
    process.exit(2);
  }
  if (abSkill && (recordPath || baselinePath)) {
    // A/B is its own comparison gate (thin vs fat); a baseline file is a
    // different, single-run comparison and the two would be ambiguous together.
    console.error("error: --ab-skill is mutually exclusive with --record/--baseline");
    process.exit(2);
  }

  // Corrected dynamic-import form (the plan's earlier `import ... from await` was a typo).
  // Resolve against cwd (the user passes repo-root-relative paths), then to a
  // file URL — bare relative specifiers resolve against THIS script's dir.
  const modulePath = pathToFileURL(resolve(process.cwd(), probeModule)).href;
  const { probes }: { probes: Probe[] } = await import(modulePath);

  const cwd = process.cwd();
  const bridgedTool = buildBridgedSubagentTool(cwd);

  // --- Phase-3 A/B: fat (all skills) vs thin (PI_SUPERPOWERS_SKILL_EXCLUDE) ---
  if (abSkill) {
    console.log(
      `[probe-runner] A/B ${probes.length} probe(s) — fat vs thin (${SKILL_EXCLUDE_ENV}=${abSkill}) via pi -p -ns…`,
    );
    const abResults: AbResult[] = [];
    for (const p of probes) {
      process.stdout.write(`  → ${p.id} fat… `);
      const t0 = Date.now();
      const fat = await runProbe(bridgedTool, p, piDispatcher({}));
      process.stdout.write(`thin… `);
      const thin = await runProbe(bridgedTool, p, piDispatcher({ [SKILL_EXCLUDE_ENV]: abSkill }));
      console.log(
        `done (${((Date.now() - t0) / 1000).toFixed(1)}s) fat=[${fat.rubricScores.join(",")}] thin=[${thin.rubricScores.join(",")}]`,
      );
      abResults.push({ id: p.id, fat, thin });
    }

    const maxRubric = Math.max(...probes.map((p) => p.rubric.length), 1);
    console.log("\n=== A/B results (fat vs thin) ===");
    for (const ab of abResults) console.log(formatAbRow(ab, maxRubric));

    const allPass = abResults.every((ab) => passed(ab.thin, ab.fat));
    console.log(
      `\n[probe-runner] A/B overall: ${allPass ? "thin within tolerance of fat" : "REGRESSION on unload"}`,
    );
    process.exit(allPass ? 0 : 1);
  }

  // --- Single-run path (subagent default | pi) ---
  const baseline = baselinePath ? loadBaseline(baselinePath) : undefined;
  const probeDispatch: ProbeDispatcher =
    mode === "pi"
      ? piDispatcher({})
      : (task) => dispatchSubagent(bridgedTool, { task });

  const results: ProbeResult[] = [];
  console.log(`[probe-runner] running ${probes.length} probe(s) [mode=${mode}]${baseline ? " vs baseline" : ""}…`);
  for (const p of probes) {
    process.stdout.write(`  → ${p.id} … `);
    const t0 = Date.now();
    try {
      const r = await runProbe(bridgedTool, p, probeDispatch);
      console.log(
        `done (${((Date.now() - t0) / 1000).toFixed(1)}s) struct=${r.structuralPassed} scores=[${r.rubricScores.join(",")}]`,
      );
      results.push(r);
    } catch (e) {
      // A totally unexpected throw (not a spawnSubagent-classified failure) —
      // record a zero result so the table still prints + the run completes.
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`THREW (${((Date.now() - t0) / 1000).toFixed(1)}s) ${msg}`);
      results.push({
        id: p.id,
        rubricScores: [],
        structuralPassed: false,
        judgeNotes: `runner threw: ${msg.slice(0, 300)}`,
        output: "",
      });
    }
  }

  // Score table.
  console.log("\n=== results ===");
  const maxRubric = Math.max(...probes.map((p) => p.rubric.length), 1);
  for (const r of results) {
    const b = baselineFor(r.id, baseline);
    console.log(formatRow(r, b, maxRubric));
  }

  if (recordPath) {
    writeFileSync(recordPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\n[probe-runner] baseline recorded → ${recordPath}`);
  }

  if (baseline) {
    const allPass = results.every((r) => passed(r, baselineFor(r.id, baseline)));
    console.log(`\n[probe-runner] overall: ${allPass ? "ALL PASS" : "REGRESSION"}`);
    process.exit(allPass ? 0 : 1);
  }
}

await main();
