/**
 * qualify.ts — the deployed-sweep driver (self-arc-14 t01).
 *
 * Replaces the ad-hoc 3-batch shell loop: spawns tui-drive.ts per scenario
 * as an INDEPENDENT process against the --sh launcher (D2 — never imports
 * the side-effectful harness script), collects each scenario's receipt.json,
 * and emits one summary table + a nonzero exit on any red. A missing or
 * unreadable receipt is RED (a vanished receipt is a crash, not a pass).
 *
 * Usage:
 *   bun bun-apps/s2-agent-ext-subagent/scripts/qualify.ts \
 *     --sh <deployed>/s2-agent.sh [--scenarios a,b] [--concurrency 3] \
 *     [--out DIR] [--timeout 360] [--rpc-pair]
 *
 * --rpc-pair (t02): alongside the screen sweep, spawn --mode rpc probes on
 * the same launcher and record structured cells (get_state model check +
 * one trivial ask settling on agent_settled) for the paired scenarios. A
 * failed probe marks its cell red but does NOT flip the screen verdict —
 * complement, not gate.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALL_SCENARIOS, buildSummary, type ScenarioId, type ScenarioOutcome } from "./lib/qualify/summary.js";

const TUI_DRIVE = path.join(import.meta.dir, "tui-drive.ts");

interface Opts {
  sh: string;
  scenarios: ScenarioId[];
  concurrency: number;
  out: string;
  timeoutS: number;
  rpcPair: boolean;
}

function parseArgs(): Opts {
  const argv = process.argv.slice(2);
  const o: Opts = {
    sh: "",
    scenarios: [...ALL_SCENARIOS],
    concurrency: 3,
    out: `output/qualify-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    timeoutS: 360,
    rpcPair: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sh") o.sh = argv[++i];
    else if (a === "--scenarios") {
      const ids = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = ids.filter((id) => !(ALL_SCENARIOS as readonly string[]).includes(id));
      if (bad.length > 0) {
        console.error(`unknown scenario(s): ${bad.join(", ")}`);
        process.exit(2);
      }
      o.scenarios = ids as ScenarioId[];
    } else if (a === "--concurrency") o.concurrency = Math.max(1, Number(argv[++i]) || 3);
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--timeout") o.timeoutS = Number(argv[++i]) || 360;
    else if (a === "--rpc-pair") o.rpcPair = true;
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!o.sh) {
    console.error("--sh <launcher> is required (deployed sweeps by construction)");
    process.exit(2);
  }
  return o;
}

interface SpawnResult {
  exitCode: number | null;
  wallMs: number;
}

/** One tui-drive scenario as an independent process (the sweep's unit of work). */
async function runScenario(scenario: ScenarioId, o: Opts): Promise<ScenarioOutcome> {
  const outDir = path.join(o.out, scenario);
  const t0 = Date.now();
  const proc = Bun.spawn(
    ["bun", TUI_DRIVE, "--scenario", scenario, "--sh", o.sh, "--out", outDir, "--timeout", String(o.timeoutS)],
    {
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;
  const wallMs = Date.now() - t0;
  let receiptPass: boolean | null = null;
  const receiptPath = path.join(outDir, "receipt.json");
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { pass?: boolean };
    receiptPass = receipt.pass === true;
  } catch {
    receiptPass = null; // missing/unreadable → red via isRed
  }
  return { scenario, receiptPass, exitCode, wallMs, receiptPath };
}

/** Bounded-parallel execution preserving input order in the results. */
async function runPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rpcCrossCheck(scenario: ScenarioId, o: Opts): Promise<string> {
  // t02: one structured probe against the same launcher. Imported from the
  // arc-13 bench lib (scripts/lib = contract-exempt importable code).
  const { rpcAdapter } = await import("./lib/bench-base-tech/adapters/rpc.js");
  const { zaiEnv } = await import("./lib/bench-base-tech/env.js");
  const cwd = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
  const session = await rpcAdapter.launch({ sh: o.sh, cwd, env: zaiEnv(), cols: 120, rows: 40 });
  try {
    const t0 = Date.now();
    // Boot/get_state: model field must read glm-5.3 and not flash (data.model
    // is an OBJECT per the arc-13 discovery — check the extracted string).
    let stateOk = false;
    for (let i = 0; i < 80; i++) {
      const st = await session.stateProbe?.();
      const model = st?.model ?? "";
      if (model.length > 0) {
        stateOk = /glm-5\.3/.test(model) && !model.includes("flash");
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!stateOk) return "state-FAIL";
    const bootMs = Date.now() - t0;
    // One trivial ask settling on agent_settled.
    await session.submit(`Reply with exactly QUALIFY-${scenario} and nothing else.`);
    const res = await session.awaitSettled(180_000, (v) =>
      Boolean((v.structured as { agentSettled?: boolean } | null)?.agentSettled),
    );
    return res.settled ? `model-ok+settled (${(bootMs / 1000).toFixed(0)}s boot)` : "ask-FAIL";
  } finally {
    await session.close();
  }
}

const opts = parseArgs();
mkdirSync(opts.out, { recursive: true });

console.log(
  `[qualify] sweep start — ${opts.scenarios.length} scenario(s), concurrency ${opts.concurrency}, sh ${opts.sh}`,
);
const outcomes = await runPool(opts.scenarios, opts.concurrency, (s) => runScenario(s, opts));

// rpc pairing (t02): default subset — the async-lifecycle scenarios where a
// structured cross-check adds the most; probes are real LLM turns, so the
// rest stay screen-only unless --scenarios narrows the sweep anyway.
const PAIRED: readonly ScenarioId[] = ["dispatch", "workflow", "wf-pause"];
if (opts.rpcPair) {
  const toPair = outcomes.filter((o) => (PAIRED as readonly string[]).includes(o.scenario));
  for (const o of toPair) {
    console.log(`[qualify] rpc-pair probing ${o.scenario}…`);
    try {
      o.rpcCrossCheck = await rpcCrossCheck(o.scenario as ScenarioId, opts);
    } catch (e) {
      o.rpcCrossCheck = `probe-CRASH: ${(e as Error).message.slice(0, 80)}`;
    }
  }
}

const summary = buildSummary(outcomes);
writeFileSync(path.join(opts.out, "summary.json"), summary.json);
writeFileSync(path.join(opts.out, "summary.md"), `${summary.md}\n`);
console.log(summary.md);
console.log(
  `[qualify] ${summary.allGreen ? "ALL GREEN" : `${summary.redCount} RED`} — summary: ${path.join(opts.out, "summary.md")}`,
);
process.exit(summary.allGreen ? 0 : 1);
