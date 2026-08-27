/**
 * tui-e2e-lane.ts — full interactive TUI E2E for the DEPLOYED s2-agent tree
 * (2026-08-27: formalizes the session lane that complemented
 * verify-deploy-e2e's headless probes on the deployed dist).
 *
 * Boots the deployed `s2-agent.sh` (outRoot/current) inside a tmux pty and
 * asserts the interactive render chain the headless E2E cannot see:
 *
 *   1. boot screen  — version banner, [Skills] block, [Extensions] block
 *                     with <inline:ultracode> and <inline:subagent>;
 *   2. model reply  — a REAL composer round-trip (computed answer 23×47=1081;
 *                     a literal token would false-positive on the prompt
 *                     echo), covering the model-call path headless E2E
 *                     budget-skips under LM Studio contention;
 *   3. panels       — /workflows navigator and /subagents viewer open and
 *                     close on Esc.
 *
 * Target resolution: <outRoot>/<platform>-<arch>/current/s2-agent.sh with a
 * fallback to the legacy flat <outRoot>/current/s2-agent.sh; outRoot = the
 * dist sibling of the repo root (the registry default deploy root). Override
 * with --sh <path> when the tree lives elsewhere.
 *
 * Usage (repo root):
 *   bun bun-apps/s2-agent-ext-subagent/scripts/tui-e2e-lane.ts \
 *     [--sh <path/to/s2-agent.sh>] [--keep] [--timeout-boot-ms 90000] \
 *     [--timeout-reply-ms 300000]
 *
 * Prereqs: tmux on PATH + a reachable model endpoint (the deployed tree
 * resolves its own model from ~/.pi/agent/settings.json).
 *
 * Exit 0 lane PASS · 1 lane FAIL · 2 SKIPPED (no tmux — on-demand lane,
 * never a CI gate). JSON receipt on stdout either way. --keep retains the
 * tmux session for inspection.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const ARGS = new Set(process.argv.slice(2));
const argValue = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const TIMEOUT_BOOT_MS = Number(argValue("--timeout-boot-ms") ?? 90_000);
const TIMEOUT_REPLY_MS = Number(argValue("--timeout-reply-ms") ?? 300_000);
const TIMEOUT_PANEL_MS = 30_000;
const POLL_MS = 500;

interface Receipt {
  lane: "tui-e2e";
  verdict: "PASS" | "FAIL" | "SKIPPED";
  target?: string;
  booted?: boolean;
  versionBanner?: string;
  skillsBlock?: boolean;
  extensionsBlock?: boolean;
  ultracodeExt?: boolean;
  subagentExt?: boolean;
  modelReply?: boolean;
  workflowsPanel?: boolean;
  workflowsClosed?: boolean;
  subagentsPanel?: boolean;
  subagentsClosed?: boolean;
  checks: { name: string; ok: boolean; ms?: number }[];
  elapsedMs?: number;
  reason?: string;
  paneTail?: string[];
}

const emit = (r: Receipt): void => console.log(JSON.stringify(r, null, 2));
const receipt: Receipt = { lane: "tui-e2e", verdict: "FAIL", checks: [] };
const check = (name: string, ok: boolean, ms?: number): boolean => {
  receipt.checks.push({ name, ok, ms });
  return ok;
};

const send = (session: string, text: string): void =>
  Bun.spawnSync(["tmux", "send-keys", "-t", session, "-l", text], { stdout: "ignore", stderr: "ignore" });
const key = (session: string, k: string): void =>
  Bun.spawnSync(["tmux", "send-keys", "-t", session, k], { stdout: "ignore", stderr: "ignore" });
const capture = (session: string): string[] => {
  const out = Bun.spawnSync(["tmux", "capture-pane", "-p", "-t", session]);
  return new TextDecoder().decode(out.stdout).split("\n");
};
const paneText = (session: string): string => capture(session).join("\n");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(deadlineMs: number, probe: () => boolean): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (probe()) return true;
    await sleep(POLL_MS);
  }
  return probe();
}

/** Deployed launcher: target-layout current first, legacy flat fallback. */
function resolveDeployedSh(): string | undefined {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const outRoot = join(repoRoot, "..", "dist", "s2-agent-sh");
  const { platform, arch } = process;
  const candidates = [
    join(outRoot, `${platform}-${arch}`, "current", "s2-agent.sh"),
    join(outRoot, "current", "s2-agent.sh"),
  ];
  return candidates.find((p) => existsSync(p));
}

async function main(): Promise<number> {
  const t0 = Date.now();
  const session = `tui-e2e-${process.pid}`;

  if (!Bun.spawnSync(["tmux", "-V"]).stdout) {
    emit({ ...receipt, verdict: "SKIPPED", reason: "tmux not on PATH" });
    return 2;
  }
  const target = argValue("--sh") ?? resolveDeployedSh();
  if (!target) {
    emit({ ...receipt, verdict: "SKIPPED", reason: "no deployed s2-agent.sh found (pass --sh <path>)" });
    return 2;
  }
  receipt.target = target;

  const cleanup = (): void => {
    if (!ARGS.has("--keep")) Bun.spawn(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
  };
  const fail = (reason: string): number => {
    receipt.reason = reason;
    receipt.elapsedMs = Date.now() - t0;
    receipt.paneTail = capture(session).slice(-15);
    emit(receipt);
    cleanup();
    return 1;
  };

  try {
    // ---- boot the DEPLOYED TUI in a real pty ----
    const tBoot = Date.now();
    Bun.spawn(["tmux", "new-session", "-d", "-x", "200", "-y", "50", "-s", session, target], {
      stdout: "ignore",
      stderr: "ignore",
    });
    Bun.spawnSync(["tmux", "set-option", "-t", session, "extended-keys", "on"], { stdout: "ignore", stderr: "ignore" });
    const booted = await waitFor(TIMEOUT_BOOT_MS, () =>
      capture(session).some((l) => /\d+(\.\d+)?%\/\d+k\s+\(auto\)/.test(l)),
    );
    receipt.booted = check("boot-interactive", booted, Date.now() - tBoot);
    if (!booted) return fail(`TUI not interactive within ${TIMEOUT_BOOT_MS}ms (no context indicator)`);

    // ---- boot-screen render chain (startup blocks paint AFTER the first
    // frame — hermes/skills load takes seconds; poll, don't snapshot) ----
    const tScreen = Date.now();
    const screenReady = await waitFor(30_000, () => {
      const t = paneText(session);
      return (
        t.includes("[Skills]") &&
        t.includes("[Extensions]") &&
        t.includes("<inline:ultracode>") &&
        t.includes("<inline:subagent>")
      );
    });
    const text = paneText(session);
    receipt.versionBanner = text.match(/s2-agent v(\S+)/)?.[0];
    receipt.skillsBlock = check("skills-block", screenReady && text.includes("[Skills]"), Date.now() - tScreen);
    receipt.extensionsBlock = check("extensions-block", screenReady && text.includes("[Extensions]"));
    receipt.ultracodeExt = check("ext-ultracode", screenReady && text.includes("<inline:ultracode>"));
    receipt.subagentExt = check("ext-subagent", screenReady && text.includes("<inline:subagent>"));
    if (!receipt.versionBanner || !screenReady) {
      return fail(
        "boot screen missing one of: version banner / [Skills] / [Extensions] / inline:ultracode / inline:subagent",
      );
    }
    await sleep(1_000);

    // ---- model round-trip: COMPUTED answer (the echoed prompt would
    // pollute a literal-token probe) ----
    const tReply = Date.now();
    send(session, "Multiply 23 by 47. Reply with only the resulting number, nothing else.");
    key(session, "Enter");
    const replied = await waitFor(TIMEOUT_REPLY_MS, () => paneText(session).includes("1081"));
    receipt.modelReply = check("model-round-trip", replied, Date.now() - tReply);
    if (!replied) return fail(`no model reply containing 1081 within ${TIMEOUT_REPLY_MS}ms`);
    await waitFor(60_000, () => !paneText(session).includes("Working..."));

    // ---- /workflows navigator: open, assert, close ----
    const tWf = Date.now();
    send(session, "/workflows");
    key(session, "Enter");
    const wfOpen = await waitFor(TIMEOUT_PANEL_MS, () =>
      capture(session).some((l) => l.includes("select") && (l.includes("esc back") || l.includes("q quit"))),
    );
    receipt.workflowsPanel = check("workflows-panel-open", wfOpen, Date.now() - tWf);
    if (!wfOpen) return fail("/workflows navigator did not open");
    key(session, "Escape");
    await sleep(1_500);
    receipt.workflowsClosed = check("workflows-panel-closed", !capture(session).some((l) => l.includes("q quit")));
    if (!receipt.workflowsClosed) return fail("/workflows navigator did not close on Esc");

    // ---- /subagents viewer: open, assert, close ----
    const tSa = Date.now();
    send(session, "/subagents");
    key(session, "Enter");
    const saOpen = await waitFor(TIMEOUT_PANEL_MS, () => paneText(session).includes("Subagent runs"));
    receipt.subagentsPanel = check("subagents-panel-open", saOpen, Date.now() - tSa);
    if (!saOpen) return fail("/subagents viewer did not open");
    key(session, "Escape");
    await sleep(1_500);
    receipt.subagentsClosed = check("subagents-panel-closed", !paneText(session).includes("Subagent runs"));
    if (!receipt.subagentsClosed) return fail("/subagents viewer did not close on Esc");

    receipt.verdict = "PASS";
    receipt.elapsedMs = Date.now() - t0;
    receipt.paneTail = capture(session).slice(-8);
    emit(receipt);
    cleanup();
    return 0;
  } finally {
    // exception path — still tear down
    if (receipt.verdict !== "PASS" && receipt.elapsedMs === undefined) cleanup();
  }
}

process.exit(await main());
