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
 * `subagent` tool is a STATIC extension (not in run-dir/manifest.extensions),
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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSubagentTool } from "../bun-apps/pi-agent-ext-subagent/src/index.ts";
import { type SpawnSubagentResult, spawnSubagent } from "../bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts";
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
): Promise<SpawnSubagentResult> {
  return spawnSubagent({
    task: opts.task,
    tools: PROBE_TOOLS,
    excludeTools: PROBE_EXCLUDE_TOOLS,
    schema: opts.schema,
    extensionTools: [bridgedTool],
    timeoutMs: PER_DISPATCH_TIMEOUT_MS,
    retryOnTransient: true,
  });
}

/** Run one probe end-to-end: dispatch → structural → judge. Never throws (records failures). */
async function runProbe(bridgedTool: ToolDefinition, p: Probe): Promise<ProbeResult> {
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

  // 1. Dispatch the probe as an isolated subagent; capture its output.
  const probeRes = await dispatchSubagent(bridgedTool, { task: p.prompt });
  const out = probeRes.output || (probeRes.exitCode !== 0 ? `[dispatch failed exit=${probeRes.exitCode}] ${probeRes.stderr}` : "");

  // 2. Structural checks (local, deterministic).
  const structuralPassed = runStructural(p.structural, out);

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

async function main() {
  const probeModule = process.argv[2];
  if (!probeModule) {
    console.error("Usage: bun scripts/probe-runner.ts <probe-module.ts> [--record <out> | --baseline <in>]");
    process.exit(2);
  }

  const flags = process.argv.slice(3);
  const recordIdx = flags.indexOf("--record");
  const baselineIdx = flags.indexOf("--baseline");
  const recordPath = recordIdx >= 0 ? flags[recordIdx + 1] : undefined;
  const baselinePath = baselineIdx >= 0 ? flags[baselineIdx + 1] : undefined;
  if (recordPath && baselinePath) {
    console.error("error: --record and --baseline are mutually exclusive");
    process.exit(2);
  }

  // Corrected dynamic-import form (the plan's earlier `import ... from await` was a typo).
  // Resolve against cwd (the user passes repo-root-relative paths), then to a
  // file URL — bare relative specifiers resolve against THIS script's dir.
  const modulePath = pathToFileURL(resolve(process.cwd(), probeModule)).href;
  const { probes }: { probes: Probe[] } = await import(modulePath);
  const baseline = baselinePath ? loadBaseline(baselinePath) : undefined;

  const cwd = process.cwd();
  const bridgedTool = buildBridgedSubagentTool(cwd);

  const results: ProbeResult[] = [];
  console.log(`[probe-runner] running ${probes.length} probe(s)${baseline ? " vs baseline" : ""}…`);
  for (const p of probes) {
    process.stdout.write(`  → ${p.id} … `);
    const t0 = Date.now();
    try {
      const r = await runProbe(bridgedTool, p);
      console.log(`done (${((Date.now() - t0) / 1000).toFixed(1)}s) struct=${r.structuralPassed} scores=[${r.rubricScores.join(",")}]`);
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
