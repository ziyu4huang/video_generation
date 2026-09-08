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
import { COMPLEX_CASES } from "./lib/bench-base-tech/cases-complex.js";
import {
  type CaseOutcome,
  recommend,
  renderComparisonMd,
  scoreTech,
  type TechScore,
} from "./lib/bench-base-tech/compare.js";
import { seedScratch, zaiEnv } from "./lib/bench-base-tech/env.js";
import { writeCaseReceipt } from "./lib/bench-base-tech/receipt.js";
import type {
  BenchAdapter,
  CaseReceipt,
  ComplexCaseDef,
  Session,
  SettleView,
  StepHelper,
  TechId,
} from "./lib/bench-base-tech/types.js";
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
  /** self-arc-15: base (default, byte-stable) | complex | all. */
  suite: "base" | "complex" | "all-suites";
}

function parseArgs(): Opts {
  const argv = process.argv.slice(2);
  const o: Opts = { tech: "all", sh: "", out: "", nonce: `s${Date.now().toString(36)}`, skip: [], suite: "base" };
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
    else if (a === "--suite") {
      const s = argv[++i];
      if (s !== "base" && s !== "complex" && s !== "all") {
        console.error("--suite must be base|complex|all");
        process.exit(2);
      }
      o.suite = s === "all" ? "all-suites" : s;
    } else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  if (!o.out)
    o.out = `output/bench${o.suite === "complex" ? "15" : "13"}-${o.tech}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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

/** self-arc-15 — run ONE complex case (step machine) against ONE session. */
async function runComplexCase(
  o: Opts,
  tech: TechId,
  nonce: string,
  def: ComplexCaseDef,
  session: Session,
): Promise<CaseReceipt> {
  const cumulative = new Set<string>();
  const stepFlags: Record<string, boolean> = {};
  const timingsMs: Record<string, number> = {};
  const stepEvidence: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  let pass = true;
  const rpc = tech === "rpc";
  const rpcSession = session as Session & {
    abortTurn?: () => Promise<boolean>;
    entriesSnapshot?: () => Promise<unknown>;
    lastAssistantText?: () => Promise<string>;
  };

  const lastTextNow = async (): Promise<string> => {
    if (rpc && rpcSession.lastAssistantText) return await rpcSession.lastAssistantText();
    return "";
  };

  for (const [i, step] of def.steps.entries()) {
    const label = `step${i}-${step.kind}`;
    const t0 = Date.now();
    try {
      if (step.kind === "submit") {
        await session.submit(step.text(nonce));
      } else if (step.kind === "wait") {
        await new Promise((r) => setTimeout(r, step.ms));
      } else if (step.kind === "abort") {
        // Lane-native abort lever: Esc bytes on screen lanes, protocol abort on rpc.
        if (rpc) {
          stepFlags.abortResponseOk = (await rpcSession.abortTurn?.()) ?? false;
        } else {
          await session.writeRaw?.("\x1b");
        }
        timingsMs[label] = Date.now() - t0;
        stepEvidence.push({ step: i, kind: "abort", ...stepFlags });
        continue;
      }
      if (step.kind === "submit" || step.kind === "poll") {
        const pred = step.pred;
        if (!pred) {
          timingsMs[label] = Date.now() - t0;
          stepEvidence.push({ step: i, kind: step.kind, skipped: "no predicate" });
          continue;
        }
        const cap = step.capMs ?? 120_000;
        const cumulativeRe = "cumulativeRe" in step && step.cumulativeRe ? new RegExp(step.cumulativeRe, "g") : null;
        let settled = false;
        while (Date.now() - t0 < cap) {
          await new Promise((r) => setTimeout(r, rpc ? 300 : 400));
          const screen = session.screenText?.() ?? null;
          if (cumulativeRe && screen) {
            for (const m of screen.matchAll(cumulativeRe)) cumulative.add(m[0]);
          }
          const text = await lastTextNow();
          const entries = rpc ? await rpcSession.entriesSnapshot?.().catch(() => null) : null;
          const helper: StepHelper = { entries, stepFlags, lastText: text, cumulative };
          const view: SettleView = { screen, structured: { agentSettled: true } };
          if (pred(view, nonce, helper)) {
            settled = true;
            break;
          }
        }
        timingsMs[label] = Date.now() - t0;
        stepEvidence.push({
          step: i,
          kind: step.kind,
          settled,
          cumulative: cumulative.size,
          lastTextHead: (await lastTextNow()).slice(0, 160),
        });
        if (!settled) {
          pass = false;
          notes.push(`${label} predicate never latched`);
        }
      }
    } catch (e) {
      pass = false;
      notes.push(`${label} threw: ${(e as Error).message}`);
      timingsMs[label] = Date.now() - t0;
    }
  }

  const finalText = await lastTextNow();
  // rpc's line accounting: cumulative is screen-only — count matches in the
  // FULL received text when the case declared a cumulative pattern.
  const rpcLines = (() => {
    if (!rpc) return 0;
    const re = COMPLEX_CASES.find((c) => c.id === def.id)?.steps.find((s) => "cumulativeRe" in s && s.cumulativeRe);
    if (!re || !("cumulativeRe" in re) || !re.cumulativeRe) return 0;
    return [...finalText.matchAll(new RegExp(re.cumulativeRe, "g"))].length;
  })();
  return {
    tech,
    case: def.id,
    nonce,
    pass,
    verdict: pass ? "pass" : "fail",
    timingsMs,
    evidence: {
      kind: rpc ? "structured" : "rendered",
      steps: stepEvidence,
      stepFlags,
      linesSeen: Math.max(cumulative.size, rpcLines),
      bytesLatched: rpc ? 0 : [...cumulative].join("\n").length,
      bytesReceived: rpc ? finalText.length : (session.screenText?.() ?? "").length,
      lastTextHead: finalText.slice(0, 200),
    },
    env: baseEnv(o),
    notes,
  };
}

function p50(xs: number[]): number {
  if (xs.length === 0) return Number.POSITIVE_INFINITY;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const opts = parseArgs();

// ── self-arc-15: complex suite paths (bun-terminal × rpc) ───────────────────
if (opts.suite === "complex" || opts.suite === "all-suites") {
  const lanes: TechId[] =
    opts.tech === "all" || opts.tech === "compare" ? ["bun-terminal", "rpc"] : [opts.tech as TechId];
  const { mkdirSync: mk, writeFileSync: wf } = await import("node:fs");
  const complexReceipts: CaseReceipt[] = [];
  for (const tech of lanes) {
    const adapter = ADAPTERS[tech];
    const cwd = seedScratch(true);
    console.log(`[bench15] lane ${tech} — ${COMPLEX_CASES.length} complex case(s), nonce ${opts.nonce}`);
    let session: Session;
    try {
      session = await adapter.launch({ sh: opts.sh, cwd, env: zaiEnv(), cols: 120, rows: 40 });
    } catch (e) {
      if (e instanceof LaneUnavailableError) {
        console.error(`[bench15] lane ${tech} UNAVAILABLE: ${e.message}`);
        continue;
      }
      throw e;
    }
    try {
      if (tech === "rpc") {
        for (let i = 0; i < 80; i++) {
          const st = await session.stateProbe?.();
          if (st && (st.model ?? "").length > 0) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        for (let i = 0; i < 60 && (session.screenText?.() ?? "").length === 0; i++) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      for (const def of COMPLEX_CASES) {
        if (opts.case && opts.case !== def.id) continue;
        const receipt = await runComplexCase(opts, tech, opts.nonce, def, session);
        complexReceipts.push(receipt);
        writeCaseReceipt(path.join(opts.out, tech), receipt, session.screenText?.() ?? null);
        console.log(`[bench15:${tech}] ${def.id}: ${receipt.verdict}`);
      }
    } finally {
      await session.close();
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  const { renderComparisonV2 } = await import("./lib/bench-base-tech/compare-v2.js");
  const md = renderComparisonV2(complexReceipts);
  mk(opts.out, { recursive: true });
  wf(path.join(opts.out, "comparison-v2.md"), `${md}\n`);
  wf(
    path.join(opts.out, "comparison-v2.json"),
    `${JSON.stringify({ receipts: complexReceipts.map((r) => ({ tech: r.tech, case: r.case, pass: r.pass, notes: r.notes })) }, null, 2)}\n`,
  );
  if (opts.resultsDir) {
    mk(opts.resultsDir, { recursive: true });
    wf(path.join(opts.resultsDir, "comparison-v2.md"), `${md}\n`);
    wf(
      path.join(opts.resultsDir, "comparison-v2.json"),
      `${JSON.stringify({ receipts: complexReceipts.map((r) => ({ tech: r.tech, case: r.case, pass: r.pass, notes: r.notes })) }, null, 2)}\n`,
    );
  }
  console.log(md);
  if (opts.suite === "complex") {
    const failed = complexReceipts.filter((r) => r.pass === false);
    process.exit(failed.length > 0 ? 1 : 0);
  }
}

if (opts.suite === "base" || opts.suite === "all-suites") {
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
    const best = Math.min(
      ...results.map((r) => p50(r.run.trivialMs)).filter(Number.isFinite),
      Number.POSITIVE_INFINITY,
    );
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
    wf(
      path.join(opts.out, "comparison.json"),
      `${JSON.stringify({ scores, recommendation: rec, outcomes }, null, 2)}\n`,
    );
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
        loc = readFileSync(
          path.join(import.meta.dir, "lib", "bench-base-tech", "adapters", `${tech}.ts`),
          "utf8",
        ).split("\n").length;
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
    const best = Math.min(
      ...results.map((r) => p50(r.run.trivialMs)).filter(Number.isFinite),
      Number.POSITIVE_INFINITY,
    );
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
    wf(
      path.join(opts.out, "comparison.json"),
      `${JSON.stringify({ scores, recommendation: rec, outcomes }, null, 2)}\n`,
    );
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
}
