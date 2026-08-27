/**
 * ultracode-pty-lane.ts — the ultracode keyword-chain regression lane
 * (2026-08-27: formalizes the session lane that verified CC-parity on the
 * deployed tree).
 *
 * Boots the REAL s2-agent TUI (repo tree, like esc-repro-lane) inside a tmux
 * pty under a SANDBOX $HOME, then asserts the whole interactive arming chain:
 *
 *   1. armed render  — typing an `ultracode` prompt colorizes the keyword
 *                      with the per-char rainbow (`ESC[38;5;Nm` cycling);
 *   2. forced turn   — submitting transforms the message (session transcript
 *                      contains "[workflows mode is ON for this message]");
 *   3. workflow run  — the model calls run_workflow; the authored workflow's
 *                      persisted run record settles terminal with agent
 *                      results containing FOO and BAR.
 *
 * WHY THE SANDBOX HOME: `~/.pi/workflows/settings.json` may legitimately set
 * `keywordTriggerEnabled: false` (it does on the dev machine this lane was
 * written on — that setting DISABLES both the rainbow and the forced
 * transform, and initially made the chain look broken). The lane writes its
 * own settings into a temp HOME (copying only ~/.pi/agent/settings.json for
 * model config), so it measures the CODE, never the user's preference.
 *
 * The trust dialog (fresh trust store under the sandbox HOME) is answered
 * "Trust (this session only)".
 *
 * Agents are pinned to the session's local model via --models so tier
 * routing cannot send tier:small agents to a contended cloud endpoint (the
 * observed failure mode 2026-08-27: zai/glm-4.7 agents erroring with "no
 * assistant output" while 4 large models were resident in LM Studio).
 *
 * Usage (repo root):
 *   bun bun-apps/s2-agent-ext-ultracode/scripts/ultracode-pty-lane.ts \
 *     [--models <spec>] [--thinking low|medium|high] [--keep] \
 *     [--timeout-boot-ms 60000] [--timeout-transform-ms 300000] \
 *     [--timeout-settle-ms 900000]
 *
 * Prereqs: tmux on PATH + a reachable local model endpoint (LM Studio
 * default http://127.0.0.1:1234; override LMSTUDIO_BASE_URL). Default
 * --models is lm-studio/prism-ml/bonsai-27b (parallel:4 slots); default
 * --thinking is low (HIGH hangs/terminates long local turns — measured).
 * Wall time varies hard with LM Studio contention: 13s-2min when quiet,
 * many minutes under multi-model contention — that variance is the lane's
 * environment, not its assertion.
 *
 * Exit 0 lane PASS · 1 lane FAIL · 2 SKIPPED (no tmux / no endpoint — this
 * is an on-demand lane, never a CI gate). JSON receipt on stdout either way.
 * --keep retains the tmux session AND the sandbox HOME for inspection.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const S2_AGENT_SH = join(import.meta.dir, "..", "..", "..", "s2-agent.sh");
const ARGS = new Set(process.argv.slice(2));
const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const MODELS = argValue("--models") ?? "lm-studio/prism-ml/bonsai-27b";
// Thinking HIGH on local LM Studio multiplies reasoning 5-20× and can hang
// or terminate long turns (measured; see the lmstudio SOP) — pin LOW for the
// lane's short author-and-dispatch task.
const THINKING = argValue("--thinking") ?? "low";
const TIMEOUT_BOOT_MS = Number(argValue("--timeout-boot-ms") ?? 60_000);
const TIMEOUT_TRANSFORM_MS = Number(argValue("--timeout-transform-ms") ?? 300_000);
const TIMEOUT_SETTLE_MS = Number(argValue("--timeout-settle-ms") ?? 900_000);
const POLL_MS = 500;

/** The armed task: substantive (≥16 chars, not a slash command) and contains
 * the `ultracode` keyword; the two words make the settle assertion crisp.
 * parallel() is named explicitly — an LLM left to itself writes sequential
 * awaits, doubling wall time on a single local model. */
const PROMPT =
  "ultracode Spin up a workflow with exactly two agents fanned out via parallel(): the first agent returns only the word FOO, the second agent returns only the word BAR. Then tell me both words.";

interface Receipt {
  lane: "ultracode-pty";
  verdict: "PASS" | "FAIL" | "SKIPPED";
  sandboxHome?: string;
  armedRender?: boolean;
  forcedTransform?: boolean;
  workflowName?: string;
  workflowStatus?: string;
  runsSeen?: string[];
  agentResults?: string[];
  elapsedMs?: number;
  reason?: string;
  paneTail?: string[];
}

const emit = (r: Receipt): void => console.log(JSON.stringify(r, null, 2));

async function sh(cmd: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    const code = (await Promise.race([
      proc.exited,
      sleep(timeoutMs).then(() => {
        proc.kill();
        return null;
      }),
    ])) as number | null;
    return { ok: code === 0 };
  } catch {
    return { ok: false };
  }
}

const send = (session: string, text: string): void =>
  Bun.spawnSync(["tmux", "send-keys", "-t", session, "-l", text], { stdout: "ignore", stderr: "ignore" });
const key = (session: string, k: string): void =>
  Bun.spawnSync(["tmux", "send-keys", "-t", session, k], { stdout: "ignore", stderr: "ignore" });
const capture = (session: string, keepAnsi = false): string[] => {
  const args = keepAnsi ? ["capture-pane", "-p", "-e", "-t", session] : ["capture-pane", "-p", "-t", session];
  const out = Bun.spawnSync(["tmux", ...args]);
  return new TextDecoder().decode(out.stdout).split("\n");
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(deadlineMs: number, probe: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await sleep(POLL_MS);
  }
  return probe();
}

/** Diagnostic twin of findSettledRun: name+status of every lane-era run. */
function listRunStatuses(projectsDir: string, laneStartIso: string): string[] {
  const out: string[] = [];
  try {
    for (const f of Array.from(new Bun.Glob("*/runs/*.json").scanSync({ cwd: projectsDir }))) {
      try {
        const j = JSON.parse(readFileSync(join(projectsDir, f), "utf8"));
        if (j.startedAt && j.startedAt > laneStartIso) out.push(`${j.workflowName}:${j.status}`);
      } catch {
        out.push(`${f}:unreadable`);
      }
    }
  } catch {
    // projects dir may not exist
  }
  return out;
}

/** Newest terminal run under the sandbox HOME with both words in results.
 * Runs live at `<home>/.pi/workflows/projects/<key>/runs/*.json`. */
function findSettledRun(projectsDir: string, laneStartIso: string): { j: any; results: string[] } | null {
  let files: string[] = [];
  try {
    // scanSync, NOT scan — scan() is an async iterator and Array.from() on it
    // silently yields [] (the bug that blinded this lane's first runs).
    files = Array.from(new Bun.Glob("*/runs/*.json").scanSync({ cwd: projectsDir }));
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(projectsDir, f), "utf8"));
      if (!j.startedAt || j.startedAt <= laneStartIso || !j.status || j.status === "running") continue;
      const results = (j.agents ?? []).map((a: any) =>
        String(
          a.resultPreview ??
            (a.history ?? [])
              .filter((h: any) => h.role === "assistant")
              .map((h: any) => h.text)
              .join(" "),
        ),
      );
      if (results.some((t: string) => t.includes("FOO")) && results.some((t: string) => t.includes("BAR"))) {
        return { j, results };
      }
    } catch {
      // unreadable/partial write — next poll
    }
  }
  return null;
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const laneStartIso = new Date(startedAt).toISOString();
  const session = `ultracode-lane-${process.pid}`;

  // ---- preflight: tmux + model endpoint (skip, not fail, when absent) ----
  if (!(await sh(["tmux", "-V"], 5_000)).ok) {
    emit({ lane: "ultracode-pty", verdict: "SKIPPED", reason: "tmux not on PATH" });
    return 2;
  }
  const base = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234";
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    emit({ lane: "ultracode-pty", verdict: "SKIPPED", reason: `no model endpoint at ${base}` });
    return 2;
  }

  // ---- sandbox HOME: model config copied, workflow settings OURS ----
  const sandbox = mkdtempSync("/tmp/ultracode-lane-home-");
  mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });
  mkdirSync(join(sandbox, ".pi", "workflows"), { recursive: true });
  cpSync(join(process.env.HOME ?? "", ".pi", "agent", "settings.json"), join(sandbox, ".pi", "agent", "settings.json"));
  // The ONE setting this lane exists to exercise: keyword arming ON.
  writeFileSync(
    join(sandbox, ".pi", "workflows", "settings.json"),
    JSON.stringify({ keywordTriggerEnabled: true }, null, 2),
  );
  const projectsDir = join(sandbox, ".pi", "workflows", "projects");

  const receipt: Receipt = { lane: "ultracode-pty", verdict: "FAIL", sandboxHome: sandbox };
  const fail = (reason: string): number => {
    receipt.reason = reason;
    receipt.elapsedMs = Date.now() - startedAt;
    receipt.paneTail = capture(session).slice(-15);
    emit(receipt);
    cleanup();
    return 1;
  };
  const cleanup = (): void => {
    if (!ARGS.has("--keep")) {
      Bun.spawn(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  };

  try {
    // ---- boot the real TUI in a pty under the sandbox HOME ----
    Bun.spawn(
      [
        "tmux",
        "new-session",
        "-d",
        "-x",
        "220",
        "-y",
        "50",
        "-s",
        session,
        "env",
        `HOME=${sandbox}`,
        S2_AGENT_SH,
        "--models",
        MODELS,
        "--thinking",
        THINKING,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    // Trust dialog: fresh trust store → answer "Trust (this session only)"
    // (3rd option: Down Down Enter).
    const trusted = await waitFor(30_000, () => capture(session).some((l) => l.includes("Trust project folder?")));
    if (trusted) {
      key(session, "Down");
      key(session, "Down");
      key(session, "Enter");
    }
    const booted = await waitFor(TIMEOUT_BOOT_MS, () =>
      capture(session).some((l) => /\d+(\.\d+)?%\/\d+k\s+\(auto\)/.test(l)),
    );
    if (!booted) return fail(`TUI not interactive within ${TIMEOUT_BOOT_MS}ms (no context indicator)`);
    await sleep(1_000);

    // ---- phase 1: armed rainbow render on the unsubmitted keyword ----
    send(session, PROMPT);
    // Rainbow ticks every 90ms; any capture within a couple seconds shows it.
    // NOTE: the colorized line interleaves a per-char SGR with EVERY letter,
    // so the plain substring "ultracode" no longer appears in the raw line —
    // strip ANSI first, then require BOTH the keyword (stripped) and a
    // 256-color SGR (raw) on the same line.
    // Regexes built from a string: biome flags control chars in regex LITERALS
    // (lint/suspicious/noControlCharactersInRegex).
    const ESC = String.fromCharCode(27); // ESC
    const sgrRe = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const color256Re = new RegExp(`${ESC}\\[38;5;\\d+m`);
    const stripAnsi = (s: string): string => s.replace(sgrRe, "");
    receipt.armedRender = await waitFor(15_000, () =>
      capture(session, true).some((l) => stripAnsi(l).includes("ultracode") && color256Re.test(l)),
    );
    if (!receipt.armedRender) return fail("keyword not rainbow-colorized in the composer (arming render broken)");

    // ---- phase 2: submit → forced transform lands in the transcript ----
    key(session, "Enter");
    const sessionDir = join(sandbox, ".pi", "agent", "sessions");
    receipt.forcedTransform = await waitFor(TIMEOUT_TRANSFORM_MS, () => {
      try {
        for (const f of Array.from(new Bun.Glob("**/*.jsonl").scanSync({ cwd: sessionDir }))) {
          if (readFileSync(join(sessionDir, f), "utf8").includes("workflows mode is ON for this message")) return true;
        }
      } catch {
        // sessions dir may not exist yet
      }
      return false;
    });
    if (!receipt.forcedTransform)
      return fail(`no "[workflows mode is ON]" in any sandbox session transcript within ${TIMEOUT_TRANSFORM_MS}ms`);

    // ---- phase 3: workflow authored, run settles with FOO+BAR ----
    let settled: { j: any; results: string[] } | null = null;
    let lastSeenRuns: string[] = [];
    const done = await waitFor(TIMEOUT_SETTLE_MS, () => {
      settled = findSettledRun(projectsDir, laneStartIso);
      if (!settled) {
        // diagnostic: what run records DO exist (name/status) so a FAIL
        // receipt explains whether the probe or the run is the problem
        lastSeenRuns = listRunStatuses(projectsDir, laneStartIso);
      }
      return settled !== null;
    });
    if (!done || !settled) {
      receipt.runsSeen = lastSeenRuns;
      return fail(`no lane-started run settled with FOO+BAR agent results within ${TIMEOUT_SETTLE_MS}ms`);
    }
    receipt.workflowName = (settled as { j: any }).j.workflowName;
    receipt.workflowStatus = (settled as { j: any }).j.status;
    receipt.agentResults = (settled as { results: string[] }).results;

    receipt.verdict = "PASS";
    receipt.elapsedMs = Date.now() - startedAt;
    receipt.paneTail = capture(session).slice(-12);
    emit(receipt);
    cleanup();
    return 0;
  } finally {
    if (receipt.verdict !== "PASS" && receipt.elapsedMs === undefined) {
      // exception path — still tear down
      cleanup();
    }
  }
}

process.exit(await main());
