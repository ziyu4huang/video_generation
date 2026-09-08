/**
 * bench-base-tech — self-arc-13 base-tech benchmark driver (spec §10).
 *
 * Runs candidate driver technologies against the DEPLOYED s2-agent.sh on a
 * shared case catalog (boot / trivial-ask / subagent-dispatch / state-probe /
 * tui-gesture / robustness-3x), writes per-case receipts, and (in --all mode)
 * generates the scored comparison table + pre-registered recommendation.
 *
 * Usage:
 *   bun bun-apps/s2-agent-ext-subagent/scripts/bench-base-tech.ts \
 *     --tech bun-terminal|bun-pty|tmux|rpc --sh <deployed>/s2-agent.sh \
 *     --out DIR [--case <id>] [--nonce S] [--source-tree]
 *   ... --all --sh <deployed> --out DIR [--skip <id>] [--results-dir DIR]
 *
 * --all requires --sh (matrix runs are deployed-only by construction).
 * Library lives in scripts/lib/bench-base-tech/ (contract-exempt subtree).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { bunPtyAdapter } from "./lib/bench-base-tech/adapters/bun-pty.js";
import { bunTerminalAdapter } from "./lib/bench-base-tech/adapters/bun-terminal.js";
import { rpcAdapter } from "./lib/bench-base-tech/adapters/rpc.js";
import { tmuxAdapter } from "./lib/bench-base-tech/adapters/tmux.js";
import { CASES, type CaseId, caseById } from "./lib/bench-base-tech/cases.js";
import {
  type CaseOutcome,
  recommend,
  renderComparisonMd,
  scoreTech,
  type TechScore,
} from "./lib/bench-base-tech/compare.js";
import { seedScratch, zaiEnv } from "./lib/bench-base-tech/env.js";
import { writeCaseReceipt } from "./lib/bench-base-tech/receipt.js";
import type { BenchAdapter, CaseReceipt, Session, TechId } from "./lib/bench-base-tech/types.js";
import { LaneUnavailableError } from "./lib/bench-base-tech/types.js";

const ADAPTERS: Record<TechId, BenchAdapter> = {
  "bun-terminal": bunTerminalAdapter,
  "bun-pty": bunPtyAdapter,
  tmux: tmuxAdapter,
  rpc: rpcAdapter,
};

const EXTERNAL_PARTS: Record<TechId, number> = { "bun-terminal": 0, "bun-pty": 1, tmux: 1, rpc: 0 };

interface Opts {
  tech: TechId | "all" | "compare";
  sh: string;
  out: string;
  case?: CaseId;
  nonce: string;
  skip: CaseId[];
  resultsDir?: string;
}

function parseArgs(): Opts {
  const argv = process.argv.slice(2);
  const o: Opts = { tech: "all", sh: "", out: "", nonce: `s${Date.now().toString(36)}`, skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tech") o.tech = argv[++i] as TechId | "compare";
    else if (a === "--all") o.tech = "all";
    else if (a === "--sh") o.sh = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--case") o.case = argv[++i] as CaseId;
    else if (a === "--nonce") o.nonce = argv[++i];
    else if (a === "--skip") o.skip.push(argv[++i] as CaseId);
    else if (a === "--results-dir") o.resultsDir = argv[++i];
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!o.out) o.out = `output/bench13-${o.tech}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (o.tech === "all" && !o.sh) {
    console.error("--all requires --sh (matrix runs are deployed-only by construction)");
    process.exit(2);
  }
  return o;
}

function shVersion(sh: string): string {
  try {
    const deployJson = path.join(path.dirname(sh), "deploy.json");
    return (JSON.parse(readFileSync(deployJson, "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "source-tree";
  }
}

function baseEnv(o: Opts): Record<string, unknown> {
  return {
    sh: o.sh,
    shVersion: shVersion(o.sh),
    bun: Bun.version,
    term: "xterm-256color",
    model: "zai/glm-5.3",
  };
}

interface RunResult {
  receipts: CaseReceipt[];
  outcomes: CaseOutcome[];
  trivialMs: number[]; // robustness reps + trivial-ask, for p50
  bootMs: number;
  bootStable: boolean;
  robustness: number;
  asyncQuality: number;
  loc: number;
}

async function fetchLastText(session: Session): Promise<string> {
  const s = session as Session & { lastAssistantText?: () => Promise<string> };
  return typeof s.lastAssistantText === "function" ? await s.lastAssistantText() : "";
}

async function runTech(o: Opts, tech: TechId, nonce: string): Promise<RunResult> {
  const adapter = ADAPTERS[tech];
  const cwd = seedScratch(true);
  const tLaunch = Date.now();
  let session: Session;
  try {
    session = await adapter.launch({ sh: o.sh, cwd, env: zaiEnv(), cols: 120, rows: 40 });
  } catch (e) {
    if (e instanceof LaneUnavailableError) {
      // Map D1 arbitration: lane structurally unusable — every case N/A with the evidence.
      console.error(`[bench] lane ${tech} UNAVAILABLE: ${e.message}`);
      const receipts: CaseReceipt[] = [];
      const outcomes: Array<{ tech: string; case: string; pass: boolean | null; ms?: number }> = [];
      const dir = path.join(o.out, tech);
      for (const c of CASES) {
        const r: CaseReceipt = {
          tech,
          case: c.id,
          nonce,
          pass: null,
          verdict: "unreachable",
          timingsMs: {},
          evidence: { kind: "lane-unavailable" },
          env: { ...baseEnv(o), error: e.message },
          notes: ["map D1 arbitration — lane mechanism unusable on this platform"],
        };
        receipts.push(r);
        writeCaseReceipt(dir, r);
        outcomes.push({ tech, case: c.id, pass: null });
      }
      return {
        receipts,
        outcomes,
        trivialMs: [],
        bootMs: -1,
        bootStable: false,
        robustness: 0,
        asyncQuality: 0,
        loc: 0,
      };
    }
    throw e;
  }
  const receipts: CaseReceipt[] = [];
  const outcomes: CaseOutcome[] = [];
  const trivialMs: number[] = [];
  let asyncQuality = 0;
  const dir = path.join(o.out, tech);

  const receipt = (
    c: CaseId,
    pass: boolean | null,
    timingsMs: Record<string, number>,
    evidence: Record<string, unknown>,
    notes: string[] = [],
    screen?: string | null,
  ) => {
    const r: CaseReceipt = {
      tech,
      case: c,
      nonce,
      pass,
      verdict: pass === null ? "unreachable" : pass ? "pass" : "fail",
      timingsMs,
      evidence,
      env: baseEnv(o),
      notes,
    };
    receipts.push(r);
    writeCaseReceipt(dir, r, screen);
    outcomes.push({ tech, case: c, pass, ms: timingsMs.settled });
  };

  try {
    // --case narrows the run to a single case (single-lane debug mode).
    const selected = (c: CaseId) => !o.case || o.case === c;
    // ── boot-to-ready ──
    if (selected("boot-to-ready")) {
      const def = caseById("boot-to-ready");
      let readyMs = -1;
      let pass = false;
      let evidence: Record<string, unknown> = {};
      if (tech === "rpc") {
        const t0 = Date.now();
        for (let i = 0; i < 80; i++) {
          const st = await session.stateProbe?.();
          if (st && typeof st.model === "string" && st.model.length > 0) {
            readyMs = Date.now() - tLaunch;
            pass = true;
            evidence = { kind: "structured", model: st.model };
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        const res = await session.awaitSettled(def.capMs, (v) => def.screenPred(v, nonce));
        readyMs = Date.now() - tLaunch;
        pass = res.settled;
        evidence = { kind: "rendered", statusBar: /\(zai\)\s*glm-5\.3/.test(res.lastView.screen ?? "") };
      }
      receipt("boot-to-ready", pass, { launch: 0, ready: readyMs }, evidence, pass ? [] : ["boot gate never latched"]);
    }

    // ── state-probe ──
    if (selected("state-probe")) {
      const def = caseById("state-probe");
      if (tech === "rpc") {
        const st = await session.stateProbe?.();
        const model = st?.model ?? "";
        const pass = /glm-5\.3/.test(model) && !model.includes("flash");
        receipt("state-probe", pass, {}, { kind: "structured", model }, pass ? [] : [`model field: ${model}`]);
      } else {
        const res = await session.awaitSettled(def.capMs, (v) => def.screenPred(v, nonce));
        receipt(
          "state-probe",
          res.settled,
          {},
          { kind: "rendered" },
          res.settled ? [] : ["status-bar model line absent/flash"],
        );
      }
    }

    // ── trivial-ask ──
    if (selected("trivial-ask")) {
      const def = caseById("trivial-ask");
      const text = def.stimulus(nonce);
      await session.submit(text);
      const t0 = Date.now();
      let pass = false;
      let evidence: Record<string, unknown> = {};
      if (tech === "rpc" && def.rpcPred) {
        const res = await session.awaitSettled(def.capMs, (v) =>
          Boolean((v.structured as { agentSettled?: boolean } | null)?.agentSettled),
        );
        const lastText = await fetchLastText(session);
        pass = res.settled && def.rpcPred(res.lastView, nonce, { lastAssistantText: lastText });
        evidence = { kind: "structured", settled: res.settled, lastText: lastText.slice(0, 200) };
        if (res.settled) trivialMs.push(res.ms);
        receipt("trivial-ask", pass, { submitted: t0, settled: res.ms }, evidence);
      } else {
        const res = await session.awaitSettled(def.capMs, (v) => def.screenPred(v, nonce));
        pass = res.settled;
        evidence = { kind: "rendered", sentinel: `BENCHPONG-${nonce}`, liveMarkersAbsent: pass };
        if (pass) trivialMs.push(res.ms);
        receipt(
          "trivial-ask",
          pass,
          { submitted: t0, settled: res.ms },
          evidence,
          pass ? [] : ["sentinel never latched or live markers persisted"],
          res.lastView.screen,
        );
      }
    }

    // ── subagent-dispatch ──
    if (selected("subagent-dispatch")) {
      const def = caseById("subagent-dispatch");
      const text = def.stimulus(nonce);
      await session.submit(text);
      let pass = false;
      let evidence: Record<string, unknown> = {};
      if (tech === "rpc" && def.rpcPred) {
        const res = await session.awaitSettled(def.capMs, (v) => {
          const st = v.structured as { agentSettled?: boolean; notification?: boolean } | null;
          return Boolean(st?.agentSettled) && (Boolean(st?.notification) || true);
        });
        const lastText = await fetchLastText(session);
        pass = res.settled && def.rpcPred(res.lastView, nonce, { lastAssistantText: lastText });
        const notif = Boolean((res.lastView.structured as { notification?: boolean } | null)?.notification);
        const marker = lastText.includes(`BENCHSUB-${nonce}`);
        asyncQuality = pass ? (notif ? 1 : marker ? 0.5 : 0) : 0;
        evidence = {
          kind: "structured",
          settled: res.settled,
          notification: notif,
          marker,
          lastText: lastText.slice(0, 200),
        };
        receipt("subagent-dispatch", pass, { settled: res.ms }, evidence);
      } else {
        const res = await session.awaitSettled(def.capMs, (v) => def.screenPred(v, nonce));
        pass = res.settled;
        const screen = res.lastView.screen ?? "";
        const notif = /<task-notification>/.test(screen);
        const marker = screen.includes(`BENCHSUB-${nonce}`);
        asyncQuality = pass ? (notif ? 1 : marker ? 0.5 : 0) : 0;
        evidence = { kind: "rendered", notification: notif, marker };
        receipt(
          "subagent-dispatch",
          pass,
          { settled: res.ms },
          evidence,
          pass ? [] : ["no notification/marker rendered"],
          screen,
        );
      }
    }

    // ── tui-gesture ──
    if (selected("tui-gesture")) {
      const def = caseById("tui-gesture");
      if (tech === "rpc") {
        receipt(
          "tui-gesture",
          null,
          {},
          { kind: "structured", reason: "no tty — /subagents viewer unreachable by construction (D8)" },
          ["expected-unreachable"],
        );
      } else {
        await session.writeRaw?.("/subagents\r");
        const res = await session.awaitSettled(def.capMs, (v) => def.screenPred(v, nonce));
        receipt(
          "tui-gesture",
          res.settled,
          { settled: res.ms },
          { kind: "rendered", viewerChrome: res.settled },
          res.settled ? [] : ["viewer chrome never rendered"],
          res.lastView.screen,
        );
      }
    }

    // ── robustness-3x ──
    if (selected("robustness-3x")) {
      const def = caseById("robustness-3x");
      const reps: number[] = [];
      const repEvidences: Array<Record<string, unknown>> = [];
      let ok = 0;
      for (let i = 1; i <= 3; i++) {
        const n = `${nonce}-r${i}`;
        await session.submit(def.stimulus(n));
        let pass = false;
        let repEvidence: Record<string, unknown> = {};
        if (tech === "rpc" && def.rpcPred) {
          const res = await session.awaitSettled(def.capMs / 3, (v) =>
            Boolean((v.structured as { agentSettled?: boolean } | null)?.agentSettled),
          );
          const lastText = await fetchLastText(session);
          pass = res.settled && def.rpcPred(res.lastView, n, { lastAssistantText: lastText });
          repEvidence = { rep: i, settled: res.settled, lastText: lastText.slice(0, 200) };
          if (pass) reps.push(res.ms);
        } else {
          const res = await session.awaitSettled(def.capMs / 3, (v) => def.screenPred(v, n));
          pass = res.settled;
          repEvidence = { rep: i, settled: res.settled };
          if (pass) reps.push(res.ms);
        }
        repEvidences.push(repEvidence);
        if (pass) ok++;
      }
      const spread = reps.length > 1 ? Math.max(...reps) - Math.min(...reps) : 0;
      receipt(
        "robustness-3x",
        ok === 3,
        { reps: ok, spreadMs: spread },
        {
          kind: tech === "rpc" ? "structured" : "rendered",
          repsMs: reps,
          perRep: repEvidences,
          lastScreen: tech === "rpc" ? undefined : (session.screenText?.() ?? "").slice(-2000),
        },
        ok === 3 ? [] : [`${3 - ok} rep(s) failed`],
      );
      trivialMs.push(...reps);
    }
  } finally {
    await session.close();
  }

  const bootReceipt = receipts.find((r) => r.case === "boot-to-ready");
  const robustReceipt = receipts.find((r) => r.case === "robustness-3x");
  let loc = 0;
  try {
    loc = readFileSync(path.join(import.meta.dir, "lib", "bench-base-tech", "adapters", `${tech}.ts`), "utf8").split(
      "\n",
    ).length;
  } catch {
    loc = 0;
  }
  return {
    receipts,
    outcomes,
    trivialMs,
    bootMs: bootReceipt?.timingsMs.ready ?? -1,
    bootStable: bootReceipt?.pass === true,
    robustness: Number(robustReceipt?.timingsMs.reps ?? robustReceipt?.evidence.reps ?? 0),
    asyncQuality,
    loc,
  };
}

function p50(xs: number[]): number {
  if (xs.length === 0) return Number.POSITIVE_INFINITY;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const opts = parseArgs();

if (opts.tech === "all") {
  const results: Array<{ tech: TechId; run: RunResult }> = [];
  for (const tech of ["bun-terminal", "bun-pty", "tmux", "rpc"] as TechId[]) {
    console.log(`[bench] lane ${tech} starting (nonce ${opts.nonce})`);
    try {
      results.push({ tech, run: await runTech(opts, tech, opts.nonce) });
    } catch (e) {
      console.error(`[bench] lane ${tech} CRASHED: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 10_000)); // inter-lane cooldown (spec §6)
  }
  const best = Math.min(...results.map((r) => p50(r.run.trivialMs)).filter(Number.isFinite), Number.POSITIVE_INFINITY);
  const inputs = results.map((r) => ({
    tech: r.tech,
    robustness: r.run.robustness,
    bootStable: r.run.bootStable,
    asyncQuality: r.run.asyncQuality,
    p50TrivialMs: p50(r.run.trivialMs),
    bootMs: r.run.bootMs,
    adapterLoc: r.run.loc,
    externalParts: EXTERNAL_PARTS[r.tech],
  }));
  const scores: TechScore[] = inputs.map((i) => scoreTech(i, Number.isFinite(best) ? best : 1));
  const rec = recommend(scores);
  const rows = results.map((r) => ({
    tech: r.tech,
    renderedTruth: ADAPTERS[r.tech].evidenceLanes.renderedTruth,
    dialogs: ADAPTERS[r.tech].evidenceLanes.dialogs,
    asyncEvents: ADAPTERS[r.tech].evidenceLanes.asyncEvents,
    deps: r.tech === "tmux" ? "tmux 3.7c" : r.tech === "bun-pty" ? "script(1)" : "none",
    loc: r.run.loc,
  }));
  const outcomes = results.flatMap((r) => r.run.outcomes);
  const md = renderComparisonMd(rows, scores, outcomes, rec);
  const { mkdirSync, writeFileSync: wf } = await import("node:fs");
  mkdirSync(opts.out, { recursive: true });
  wf(path.join(opts.out, "comparison.json"), `${JSON.stringify({ scores, recommendation: rec, outcomes }, null, 2)}\n`);
  wf(path.join(opts.out, "comparison.md"), `${md}\n`);
  if (opts.resultsDir) {
    mkdirSync(opts.resultsDir, { recursive: true });
    wf(
      path.join(opts.resultsDir, "comparison.json"),
      `${JSON.stringify({ scores, recommendation: rec, outcomes }, null, 2)}\n`,
    );
    wf(path.join(opts.resultsDir, "comparison.md"), `${md}\n`);
  }
  console.log(md);
  console.log(
    `[bench] comparison written to ${path.join(opts.out, "comparison.md")}${opts.resultsDir ? ` + ${opts.resultsDir}` : ""}`,
  );
} else if (opts.tech === "compare") {
  // Regenerate the comparison from EXISTING receipt files under --out/<tech>/
  // (used after per-lane case re-runs overwrite individual cases).
  const { readdirSync } = await import("node:fs");
  const results: Array<{ tech: TechId; run: RunResult }> = [];
  for (const tech of ["bun-terminal", "bun-pty", "tmux", "rpc"] as TechId[]) {
    const dir = path.join(opts.out, tech);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("case-") && f.endsWith(".json"));
    } catch {
      continue;
    }
    const receipts: CaseReceipt[] = files.map(
      (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as CaseReceipt,
    );
    const trivialMs = receipts
      .filter(
        (r) => (r.case === "trivial-ask" || r.case === "robustness-3x") && typeof r.timingsMs.settled === "number",
      )
      .map((r) => r.timingsMs.settled as number)
      .concat(
        ((receipts.find((r) => r.case === "robustness-3x")?.evidence.repsMs as number[] | undefined) ?? []).filter(
          (x) => typeof x === "number",
        ),
      );
    const boot = receipts.find((r) => r.case === "boot-to-ready");
    const robust = receipts.find((r) => r.case === "robustness-3x");
    let loc = 0;
    try {
      loc = readFileSync(path.join(import.meta.dir, "lib", "bench-base-tech", "adapters", `${tech}.ts`), "utf8").split(
        "\n",
      ).length;
    } catch {
      loc = 0;
    }
    results.push({
      tech,
      run: {
        receipts,
        outcomes: receipts.map((r) => ({ tech, case: r.case, pass: r.pass, ms: r.timingsMs.settled })),
        trivialMs,
        bootMs: boot?.timingsMs.ready ?? -1,
        bootStable: boot?.pass === true,
        robustness: Number(robust?.timingsMs.reps ?? robust?.evidence.reps ?? 0),
        asyncQuality: 0,
        loc,
      },
    });
  }
  // asyncQuality is not derivable from receipts alone — carry the subagent
  // evidence kinds: notification/marker → 1/0.5.
  for (const r of results) {
    const sg = r.run.receipts.find((x) => x.case === "subagent-dispatch");
    if (sg?.pass === true) r.run.asyncQuality = sg.evidence.notification ? 1 : sg.evidence.marker ? 0.5 : 0;
  }
  const best = Math.min(...results.map((r) => p50(r.run.trivialMs)).filter(Number.isFinite), Number.POSITIVE_INFINITY);
  const scores = results.map((r) =>
    scoreTech(
      {
        tech: r.tech,
        robustness: r.run.robustness,
        bootStable: r.run.bootStable,
        asyncQuality: r.run.asyncQuality,
        p50TrivialMs: p50(r.run.trivialMs),
        bootMs: r.run.bootMs,
        adapterLoc: r.run.loc,
        externalParts: EXTERNAL_PARTS[r.tech],
      },
      Number.isFinite(best) ? best : 1,
    ),
  );
  const rec = recommend(scores);
  const rows = results.map((r) => ({
    tech: r.tech,
    renderedTruth: ADAPTERS[r.tech].evidenceLanes.renderedTruth,
    dialogs: ADAPTERS[r.tech].evidenceLanes.dialogs,
    asyncEvents: ADAPTERS[r.tech].evidenceLanes.asyncEvents,
    deps: r.tech === "tmux" ? "tmux 3.7c" : r.tech === "bun-pty" ? "script(1)" : "none",
    loc: r.run.loc,
  }));
  const outcomes = results.flatMap((r) => r.run.outcomes);
  const md = renderComparisonMd(rows, scores, outcomes, rec);
  const { mkdirSync, writeFileSync: wf } = await import("node:fs");
  mkdirSync(opts.out, { recursive: true });
  wf(path.join(opts.out, "comparison.json"), `${JSON.stringify({ scores, recommendation: rec, outcomes }, null, 2)}\n`);
  wf(path.join(opts.out, "comparison.md"), `${md}\n`);
  if (opts.resultsDir) {
    mkdirSync(opts.resultsDir, { recursive: true });
    wf(
      path.join(opts.resultsDir, "comparison.json"),
      `${JSON.stringify({ scores, recommendation: rec, outcomes }, null, 2)}\n`,
    );
    wf(path.join(opts.resultsDir, "comparison.md"), `${md}\n`);
  }
  console.log(md);
  console.log(`[bench] comparison regenerated from ${opts.out}`);
} else {
  const run = await runTech(opts, opts.tech, opts.nonce);
  for (const r of run.receipts)
    console.log(
      `[bench:${opts.tech}] ${r.case}: ${r.verdict}${r.timingsMs.settled != null ? ` (${r.timingsMs.settled}ms)` : ""}`,
    );
  const failed = run.receipts.filter((r) => r.pass === false);
  if (failed.length > 0) {
    console.error(`[bench:${opts.tech}] ${failed.length} case(s) FAILED`);
    process.exit(1);
  }
}
