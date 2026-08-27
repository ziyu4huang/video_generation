/**
 * esc-repro-lane.ts — the on-demand Esc-repro regression lane (2026-08-27
 * handoff: formalize the pty harness that caught #2067, with the badge-glyph
 * detector as the settle-vs-partial discriminator).
 *
 * Boots the REAL s2-agent TUI inside a tmux pty, dispatches a tier:small
 * subagent, waits for the STREAMING partial (detector: `elapsed · N tool
 * calls` line), presses Esc, then asserts the settled row's badge is `⊘
 * aborted` — not the `⏱ timedout` #2067 shipped with. Would have caught
 * #2067 pre-ship; run it after any change to the Esc/abort/settle seam
 * (child-dispatch, subagent-tool, dispatchChild signal fan-in).
 *
 * Usage (repo root):
 *   bun bun-apps/s2-agent-ext-subagent/scripts/esc-repro-lane.ts \
 *     [--expect aborted] [--timeout-boot-ms 60000] [--timeout-partial-ms 120000] \
 *     [--timeout-settle-ms 60000] [--keep]
 *
 * Prereqs: tmux on PATH + a reachable local model endpoint (LM Studio
 * default http://127.0.0.1:1234; override LMSTUDIO_BASE_URL / SEMANTIC_EMBED_BASE
 * style alias not used here — plain LMSTUDIO_BASE_URL only). The parent model
 * is whatever ~/.pi/agent/settings.json defaults to; the child resolves via
 * the tier registry.
 *
 * Exit 0 lane PASS (settled badge matched --expect) · 1 lane FAIL (settled
 * with a different badge, or a phase timed out) · 2 SKIPPED (no tmux / no
 * model endpoint — this is an on-demand lane, never a CI gate). JSON receipt
 * on stdout either way. --keep retains the tmux session for inspection.
 */
import { join } from "node:path";
import { detectSettledRow, detectStreamingPartial, type SettleStatus } from "../src/esc-settle-detector.js";

const S2_AGENT_SH = join(import.meta.dir, "..", "..", "..", "s2-agent.sh");
const ARGS = new Set(process.argv.slice(2));
const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const EXPECT = (argValue("--expect") ?? "aborted") as SettleStatus;
const TIMEOUT_PARTIAL_MS = Number(argValue("--timeout-partial-ms") ?? 120_000);
const TIMEOUT_SETTLE_MS = Number(argValue("--timeout-settle-ms") ?? 60_000);
const TIMEOUT_BOOT_MS = Number(argValue("--timeout-boot-ms") ?? 60_000);
const POLL_MS = 500;

/** The dispatched task: long enough that the partial reliably appears before
 *  Esc lands (the #2067 repro shape — a 900-word essay on tier:small). */
const PROMPT =
  "Dispatch one tier:small subagent with this task: write a detailed 900-word essay about fjords with three sections. After it finishes, summarize its result in one sentence.";

interface Receipt {
  lane: "esc-repro";
  verdict: "PASS" | "FAIL" | "SKIPPED";
  expect: SettleStatus;
  settled?: { status: SettleStatus; line: string } | null;
  partialSeen: boolean;
  elapsedMs?: number;
  reason?: string;
  paneTail?: string[];
}

const emit = (r: Receipt): void => {
  console.log(JSON.stringify(r, null, 2));
};

async function main(): Promise<number> {
  const session = `esc-lane-${process.pid}`;
  const startedAt = Date.now();

  // ---- preflight: tmux + model endpoint (skip, not fail, when absent) ----
  const tmuxOk = await sh(["tmux", "-V"], 5_000);
  if (!tmuxOk.ok) {
    emit({ lane: "esc-repro", verdict: "SKIPPED", expect: EXPECT, partialSeen: false, reason: "tmux not on PATH" });
    return 2;
  }
  const base = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234";
  let modelOk = false;
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(3_000) });
    modelOk = res.ok;
  } catch {
    modelOk = false;
  }
  if (!modelOk) {
    emit({
      lane: "esc-repro",
      verdict: "SKIPPED",
      expect: EXPECT,
      partialSeen: false,
      reason: `no model endpoint at ${base}`,
    });
    return 2;
  }

  const cleanup = (): void => {
    if (!ARGS.has("--keep")) Bun.spawn(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
  };

  try {
    // ---- boot the real TUI in a pty ----
    Bun.spawn(["tmux", "new-session", "-d", "-x", "220", "-y", "50", "-s", session, S2_AGENT_SH], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Wait for READINESS, not a fixed beat: extension load + hermes banner
    // takes 12-20s, and a prompt typed into the boot banner is lost. The
    // composer's context indicator (`0.0%/262k (auto)`) only renders once the
    // TUI is interactive.
    const bootDeadline = Date.now() + TIMEOUT_BOOT_MS;
    let booted = false;
    while (Date.now() < bootDeadline) {
      if (capture(session).some((l) => /\d+(\.\d+)?%\/\d+k\s+\(auto\)/.test(l))) {
        booted = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!booted) {
      emit({
        lane: "esc-repro",
        verdict: "FAIL",
        expect: EXPECT,
        partialSeen: false,
        elapsedMs: Date.now() - startedAt,
        reason: `TUI did not become interactive within ${TIMEOUT_BOOT_MS}ms (no context indicator)`,
        paneTail: capture(session).slice(-12),
      });
      return 1;
    }
    await sleep(1_000); // composer takes focus after the first paint

    // ---- dispatch the subagent ----
    tmuxSend(session, PROMPT);
    tmuxKey(session, "Enter");

    // ---- phase 1: wait for the streaming partial (Esc BEFORE it races the dispatch) ----
    const partialDeadline = Date.now() + TIMEOUT_PARTIAL_MS;
    let partialSeen = false;
    while (Date.now() < partialDeadline) {
      if (detectStreamingPartial(capture(session))) {
        partialSeen = true;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!partialSeen) {
      emit({
        lane: "esc-repro",
        verdict: "FAIL",
        expect: EXPECT,
        partialSeen: false,
        elapsedMs: Date.now() - startedAt,
        reason: `no streaming partial within ${TIMEOUT_PARTIAL_MS}ms — did the dispatch happen?`,
        paneTail: capture(session).slice(-12),
      });
      return 1;
    }

    // ---- phase 2: Esc mid-run ----
    tmuxKey(session, "Escape");

    // ---- phase 3: wait for the settled row, assert its badge ----
    const settleDeadline = Date.now() + TIMEOUT_SETTLE_MS;
    for (;;) {
      const settled = detectSettledRow(capture(session));
      if (settled) {
        const pass = settled.status === EXPECT;
        emit({
          lane: "esc-repro",
          verdict: pass ? "PASS" : "FAIL",
          expect: EXPECT,
          settled: { status: settled.status, line: settled.line },
          partialSeen,
          elapsedMs: Date.now() - startedAt,
          ...(pass ? {} : { reason: `settled badge ≠ expected (the #2067 shape: aborted misbadged)` }),
          paneTail: capture(session).slice(-12),
        });
        return pass ? 0 : 1;
      }
      if (Date.now() >= settleDeadline) break;
      await sleep(POLL_MS);
    }
    emit({
      lane: "esc-repro",
      verdict: "FAIL",
      expect: EXPECT,
      settled: null,
      partialSeen,
      elapsedMs: Date.now() - startedAt,
      reason: `no settled row within ${TIMEOUT_SETTLE_MS}ms after Esc`,
      paneTail: capture(session).slice(-12),
    });
    return 1;
  } finally {
    cleanup();
  }
}

/** Run a command, return ok = exit 0. */
async function sh(cmd: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    const code = await Promise.race([proc.exited, sleep(timeoutMs).then(() => null)]);
    if (code === null) proc.kill();
    return { ok: code === 0 };
  } catch {
    return { ok: false };
  }
}

function tmuxSend(session: string, text: string): void {
  Bun.spawnSync(["tmux", "send-keys", "-t", session, "-l", text], { stdout: "ignore", stderr: "ignore" });
}

function tmuxKey(session: string, key: string): void {
  Bun.spawnSync(["tmux", "send-keys", "-t", session, key], { stdout: "ignore", stderr: "ignore" });
}

function capture(session: string): string[] {
  const out = Bun.spawnSync(["tmux", "capture-pane", "-p", "-t", session]);
  return new TextDecoder().decode(out.stdout).split("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

process.exit(await main());
