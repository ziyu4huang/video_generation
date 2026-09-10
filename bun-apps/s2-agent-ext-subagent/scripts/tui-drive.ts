/**
 * tui-drive.ts — drive the REAL s2-agent TUI through a Bun.Terminal PTY, like
 * a human at a keyboard, and emit a machine-readable receipt (tui-cc-parity-2
 * ticket 04; the self-evolve loop's "deploy → drive → find issues" vehicle).
 *
 * Why Bun.Terminal (per the effort's direction): the self-evolve pipeline —
 * develop → deploy (s2-agent.sh) → ext tools/skills run through s2-agent's
 * internals → issues found → develop — needs a terminal-side driver, not a
 * tmux screen-scrape. Bun ≥1.3.5 ships the PTY natively (no node-pty).
 *
 * Hard-won emulation lessons (all three are load-bearing, see the effort map D1):
 *  1. xterm-headless must be fed in SMALL awaited chunks (64B) — a large
 *     single write stalls its WriteBuffer under Bun and the screen silently
 *     never updates.
 *  2. The child must get TERM=xterm-256color — an inherited TERM=dumb makes
 *     the TUI degrade to static output and nothing renders.
 *  3. pi-tui queries the terminal at boot: answer primary DA (`\x1b[c`) with
 *     the xterm reply, stay SILENT on the kitty `\x1b[?u` query so pi uses
 *     its legacy key encoding (answering would commit us to CSI-u output).
 *
 * Model policy (map D2): pure zai GLM — main glm-5.3, vision/flash
 * glm-5.3-flash. ZAI_API_KEY is parsed from the user's zshrc when the shell
 * did not export it. The receipt records the status-bar model line so a
 * silent lm-studio fallback is VISIBLE, not assumed.
 *
 * Usage (from the repo root):
 *   bun bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts                     # dispatch scenario, repo source tree
 *   bun ... tui-drive.ts --sh <deployed>/s2-agent.sh --out /tmp/receipt         # drive a DEPLOYED tree
 *
 * Relationship to `tui-e2e-lane.ts` (same scripts/ dir): that lane is the
 * tmux-based deployed-tree BOOT smoke (banner / model reply / panels open).
 * This script is the Bun.Terminal-native DEEP drive — it dispatches a real
 * foreground subagent and asserts the CC-parity live-row affordances — which
 * is the loop's issue-finder, not a boot check.
 *
 * Output: `<out>/receipt.json` + numbered `snap-NN.txt` screen snapshots
 * (captured on change). Exit 0 iff every check passes; 1 otherwise.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { awaitBootRendered, callLineModelIsGlm53, lineHasGlm53NonFlash, UI_VOCAB as V } from "./lib/tui-drive-lib.ts";

// ── xterm-headless (browser-flavored UMD — shim globals for load, then strip) ──
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.self = globalThis;
g.navigator ??= { userAgent: "s2-tui-drive", platform: os.platform() };
g.document = { createElement: () => ({ style: {} }) };
const { Terminal: XTerm } = await import("xterm-headless");
delete g.window;
delete g.document;
delete g.self;

// ── CLI ──────────────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const S2 = path.join(REPO_ROOT, "s2-agent.sh");

interface Opts {
  scenario:
    | "dispatch"
    | "parallel"
    | "viewer"
    | "agents"
    | "reload"
    | "swarm"
    | "catalog"
    | "workflow"
    | "wf-pause"
    | "cc-parity"
    | "steer";
  sh: string;
  cwd: string;
  out: string;
  timeoutS: number;
  quietMs: number;
  expectModel: RegExp;
}
function parseArgs(): Opts {
  const o: Opts = {
    scenario: "dispatch",
    sh: S2, // repo source tree by default; --sh targets a deployed launcher
    cwd: "",
    out: path.join(os.tmpdir(), `tui-drive-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    timeoutS: 300,
    quietMs: 3000,
    expectModel: /glm/,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") o.scenario = String(argv[++i]) as Opts["scenario"];
    else if (a === "--sh") o.sh = String(argv[++i]);
    else if (a === "--cwd") o.cwd = String(argv[++i]);
    else if (a === "--out") o.out = String(argv[++i]);
    else if (a === "--timeout") o.timeoutS = Number(argv[++i]);
    else if (a === "--quiet-ms") o.quietMs = Number(argv[++i]);
    else if (a === "--expect-model") o.expectModel = new RegExp(String(argv[++i]));
    else if (a === "--help" || a === "-h") {
      console.log(
        "flags: --scenario dispatch --sh PATH --cwd DIR --out DIR --timeout S --quiet-ms MS --expect-model RE",
      );
      process.exit(0);
    }
  }
  return o;
}
const opts = parseArgs();
mkdirSync(opts.out, { recursive: true });

// Scratch project when no --cwd: a couple of files so the subagent's task
// (`ls` + read + count exports) has something real to do. Every scenario also
// seeds the hard-problem agentType (model zai/glm-5.3 + the loop's operating
// learnings) — children dispatch THROUGH it, and the receipt's
// childModelIsGlm53 check proves the big-model binding end-to-end. The agents
// scenario additionally seeds a plain probe definition for the manager list.
if (!opts.cwd) {
  opts.cwd = mkdtempSync(path.join(os.tmpdir(), "s2-tui-probe-"));
  writeFileSync(path.join(opts.cwd, "sample.ts"), "export const a = 1\nexport function b() { return a + 1 }\n");
  writeFileSync(path.join(opts.cwd, "README.md"), "# tui-drive scratch\n");
  mkdirSync(path.join(opts.cwd, ".pi", "agents"), { recursive: true });
  writeFileSync(
    path.join(opts.cwd, ".pi", "agents", "hard-problem.md"),
    [
      "---",
      "name: hard-problem",
      "description: Deep analysis on hard problems — bound to the big model.",
      "model: zai/glm-5.3",
      "---",
      "You are the hard-problem analyst. Operating learnings: read the actual artifact",
      "(bundle / receipt / snapshot) before theorizing; deployed \u2260 source; a version",
      "label is not the content; a freshly-mounted dialog eats the first keypress.",
    ].join("\n"),
  );
  if (opts.scenario === "agents") {
    writeFileSync(
      path.join(opts.cwd, ".pi", "agents", "probe.md"),
      "---\nname: probe\ndescription: seeded by tui-drive\ntools: read, bash\n---\nDo the probe: read README.md and report its first line.",
    );
  }
  // self-arc-12 t04 — cc-parity scenario seeds: the chain source (a token
  // file), the reviewer target (a file with one planted off-by-one), and the
  // read-only reviewer agentType (CC canonical example: tools exclude
  // edit/write; bound to zai/glm-5.3 so childModelIsGlm53 is provable).
  if (opts.scenario === "cc-parity") {
    writeFileSync(path.join(opts.cwd, "secret-token.md"), "# scratch\nTOKEN: cc-parity-7f3a\n");
    writeFileSync(
      path.join(opts.cwd, "planted-bug.ts"),
      [
        "// The off-by-one in sumTo is INTENTIONAL (cc-parity reviewer target).",
        "export function sumTo(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i++) total += i; // drops the final addend",
        "  return total;",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      path.join(opts.cwd, ".pi", "agents", "cc-code-reviewer.md"),
      [
        "---",
        "name: cc-code-reviewer",
        "description: Read-only code reviewer — reports FINDING: lines, never edits.",
        "model: zai/glm-5.3",
        "tools: read, grep, glob",
        "---",
        "You are the code reviewer for the CC-parity scenario. Examine the given",
        "file and reply with FINDING: lines describing defects. You never modify",
        "files and you never run shell commands.",
      ].join("\n"),
    );
  }
}

/** ZAI_API_KEY from the user's zshrc — the sandbox/login shell may not have
 *  exported it. Never echoed. */
function parseZaiKey(): string | undefined {
  try {
    const rc = readFileSync(path.join(process.env.HOME ?? "", ".zshrc"), "utf8");
    const m = rc.match(/^export ZAI_API_KEY=(?:"([^"]+)"|'([^']+)'|(\S+))/m);
    return m?.[1] ?? m?.[2] ?? m?.[3];
  } catch {
    return undefined;
  }
}

if (typeof Bun.Terminal !== "function") {
  console.error(
    `error: Bun.Terminal unavailable — Bun ≥1.3.5 required (this machine runs ${Bun.version}; is PATH's bun stale?)`,
  );
  process.exit(2);
}

// ── pty + screen ─────────────────────────────────────────────────────────────
const COLS = 100;
const ROWS = 36;
const term = new XTerm({ cols: COLS, rows: ROWS, allowProposedApi: true });
let lastByteAt = Date.now();
let bytesSeen = 0;

const env: Record<string, string> = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
const zaiKey = process.env.ZAI_API_KEY || parseZaiKey();
if (zaiKey) env.ZAI_API_KEY = zaiKey;

const proc = Bun.spawn([opts.sh], {
  cwd: opts.cwd,
  env,
  terminal: {
    cols: COLS,
    rows: ROWS,
    data(_t, data) {
      const u8 = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      bytesSeen += u8.byteLength;
      lastByteAt = Date.now();
      respondQueries(u8);
      for (let i = 0; i < u8.length; i += 64) pending.push(u8.subarray(i, Math.min(i + 64, u8.length)));
      void drain();
    },
  },
});
const tty = (proc as unknown as { terminal: { write(s: Uint8Array | string): void } }).terminal;

let inReply = false;
function respondQueries(u8: Uint8Array): void {
  if (inReply) return;
  const s = new TextDecoder().decode(u8);
  if (s.includes("\x1b[c")) {
    inReply = true;
    tty.write("\x1b[?1;2c"); // xterm-style primary DA
    inReply = false;
  }
  // kitty `\x1b[?u` intentionally unanswered → pi falls back to legacy keys.
}

const pending: Uint8Array[] = [];
let draining = false;
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const c = pending.shift();
      if (!c) break;
      await new Promise<void>((res) => term.write(c, () => res()));
    }
  } finally {
    draining = false;
    // Reviewer finding #5: a chunk pushed between the final empty shift() and
    // this flag reset would sit unread until the NEXT pty data event (its
    // early-return drain() saw draining === true), leaving the screen stale
    // while lastByteAt already ticked. Re-arm so the burst is drained now.
    if (pending.length > 0) void drain();
  }
}

function screen(): string[] {
  const buf = term.buffer.active;
  const base = buf.viewportY;
  const lines: string[] = [];
  for (let y = 0; y < ROWS; y++) {
    const l = buf.getLine(base + y);
    lines.push((l ? l.translateToString(true) : "").trimEnd());
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
/** The status bar's model segment — the receipt's truth for WHICH model ran. */
function modelLine(): string {
  const m = screen().find((l) => /• (low|medium|high|max)\s*$/.test(l) || /\)\s+\S+ • /.test(l));
  return m?.trim() ?? "";
}

/** The child's model, read off the subagent rows. Four render shapes carry it
 *  (all receipted): the live call row `Task: … ▸ <model> ▸ spawn_subagent`
 *  (dispatch, expanded trace), `Task(…)` live rows, per-child trace/settled
 *  rows `[N] <model> ⏱ …` / `[N] ✓ done <model> · …` (parallel batch), and
 *  viewer rows (bg marker, dot, `<actor> <model> · …`). "glm-5.3" is a SUBSTRING of
 *  "glm-5.3-flash", so flash is excluded BY NAME; the parent's own status bar
 *  (`(zai) glm-5.3 • medium`) is excluded structurally — a child row must
 *  START with one of the row markers. This is the receipt's proof that the
 *  hard-problem (zai/glm-5.3) binding actually routed. */
function childModelIsGlm53(): boolean {
  const row = screen().find((l) => {
    const t = l.trimStart();
    if (!/^(Task\(|Task:|\[\d+\]|bg\b|▶)/.test(t)) return false;
    return lineHasGlm53NonFlash(t);
  });
  return !!row;
}

let snapN = 0;
let lastBody = "";
function snap(label: string, force = false): void {
  const s = screen();
  const body = s.join("\n");
  if (!force && body === lastBody) return;
  lastBody = body;
  snapN += 1;
  writeFileSync(
    path.join(opts.out, `snap-${String(snapN).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_")}.txt`),
    `## snap ${snapN} — ${label} @ ${new Date().toISOString()}\n${s.map((l) => `│${l}`).join("\n")}\n`,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitIdle(quiet = 1500, cap = 45000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - lastByteAt >= quiet) return;
    if (Date.now() - t0 > cap) return;
    await sleep(150);
  }
}

// ── scenario: dispatch ───────────────────────────────────────────────────────

// ── launcher provenance (self-arc-19 t01, map D3) ────────────────────────────
interface LauncherProvenance {
  sh: string;
  shRealpath?: string;
  deployedVersion?: string | null;
  gitSha: string;
  tree: "source" | "deployed";
}
/** Best-effort — never fails the drive. `deployedVersion` parses the dist
 *  version-dir label off the realpath (`current` → `0.10.0+g<sha>`); the
 *  `<sh> --version` fallback is bounded (5s) for future launchers that grow
 *  the flag. `gitSha` is the SOURCE tree's HEAD (cwd), the loop's develop-side
 *  truth — the deployed tree's own sha is `deployedVersion`'s g<sha> when
 *  present, which is exactly the deployed≠source comparison the loop needs. */
function probeLauncher(): LauncherProvenance {
  let shRealpath: string | undefined;
  try {
    shRealpath = realpathSync(opts.sh);
  } catch {
    /* vanished between argv and probe — keep the argv form */
  }
  const isDeployed = /[/\\]dist[/\\]s2-agent-sh[/\\]/.test(shRealpath ?? opts.sh);
  const versionDir = isDeployed && shRealpath ? /(\d+\.\d+\.\d+\+g[0-9a-f]+)/.exec(shRealpath)?.[1] : undefined;
  let deployedVersion: string | null = versionDir ?? null;
  if (isDeployed && !deployedVersion) {
    try {
      const p = Bun.spawnSync([opts.sh, "--version"], { cwd: opts.cwd, timeout: 5000, stdout: "pipe", stderr: "pipe" });
      const out = new TextDecoder().decode(p.stdout).trim();
      if (out) deployedVersion = out.split("\n")[0];
    } catch {
      /* best-effort only */
    }
  }
  let gitSha = "";
  try {
    gitSha = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: opts.cwd }).stdout).trim();
  } catch {
    /* not a git tree (deployed scratch cwd) — sha stays empty */
  }
  return { sh: opts.sh, shRealpath, deployedVersion, gitSha, tree: isDeployed ? "deployed" : "source" };
}

interface Receipt {
  scenario: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  bytesSeen: number;
  snaps: number;
  modelLine: string;
  checks: Record<string, boolean>;
  pass: boolean;
  launcher: LauncherProvenance;
}
const receipt: Receipt = {
  scenario: opts.scenario,
  cwd: opts.cwd,
  startedAt: new Date().toISOString(),
  bytesSeen: 0,
  snaps: 0,
  modelLine: "",
  checks: {},
  pass: false,
  launcher: probeLauncher(),
};

async function scenarioDispatch(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the spawn_subagent tool NOW, exactly once, foreground (background not set), with agentType set to hard-problem, task: run `ls -la` in the current directory, then read sample.ts, then report the number of exported functions and the file count. Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");
  await sleep(1500);
  snap("submitted", true);

  let expanded = false;
  /** Actual on-screen expand state (ctrl+o toggles the whole app's tool rows). */
  let expandedNow = false;
  let sawLive = false;
  let sawHint = false;
  let sawTraceGrowth = false;
  const t0 = Date.now();
  /** Count live-trace marker lines (→ call in-flight / ✓ paired result / ✗ ⚠
   *  error / assistant prose quote) — the expanded view's signal. */
  const traceMarkers = (s: string): number => s.split("\n").filter((l) => /^\s*(→ |✓ |✗ |⚠ )/.test(l)).length;
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    const s = screen().join("\n");
    // LIVE heuristic — spinner frames / the working indicator / the interrupt
    // hint only. Transcript STAYS visible after the run settles, so matching
    // on `Task(`/tool names here would never go false and the loop would ride
    // its timeout cap (found by the first real receipt run).
    const running = V.liveMarker.test(s);
    if (running) {
      sawLive = true;
      if (V.expandHint.test(s)) sawHint = true;
      if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
      // t01 liveModelSlot (self-arc-9; LATCHED in-loop): judge the LIVE call
      // LINE, not the whole screen — only a line that carries the trailing
      // spawn_subagent segment can be the call line, so transcript prose
      // (which mentions the tool and the model in separate sentences) cannot
      // fake it. Pre-fix, that line's model segment froze on the
      // renderCall-time snapshot (`▸ default ▸`) and never flipped.
      for (const line of screen()) {
        if (!line.includes("spawn_subagent")) continue;
        receipt.checks.sawTaskLine = true;
      }
      // self-arc-19 t01 (map D2): the live call row WRAPS at COLS=100 — the
      // model segment (`▸ glm-5.3 ▸`) and the trailing spawn_subagent segment
      // land on ADJACENT lines (receipted: output/self-arc14-deployed-
      // dispatch-20260908 snap-10, and that run's receipt never latched
      // liveModelSlot) — so judge the joined neighbor pairs, not the line.
      if (!receipt.checks.liveModelSlot && callLineModelIsGlm53(screen())) {
        receipt.checks.liveModelSlot = true;
      }
    }
    snap(running ? "running" : "after-run");
    if (running && !expanded && Date.now() - t0 > 8000) {
      // Expand ONCE and KEEP it expanded (what a curious human does): the
      // child may still have an EMPTY history at this point — the parent's
      // thinking time eats the first ~10s (receipt #2: ctrl+o landed at
      // "0.1s elapsed · 0 tool calls") — so the trace fills in over the
      // following ticks. Probe-once-toggle-back read false-negative there.
      expanded = true;
      expandedNow = true;
      tty.write("\x0f"); // ctrl+o — expand the live trace (CC parity affordance)
      await sleep(400);
    }
    if (expandedNow && traceMarkers(screen().join("\n")) >= 3) sawTraceGrowth = true;
    if (!running && sawLive && Date.now() - lastByteAt > opts.quietMs) break;
  }
  if (expandedNow) {
    tty.write("\x0f"); // collapse back so the settled transcript stays compact
    await sleep(400);
    expandedNow = false;
  }
  snap("settled", true);
  const settledScreen = screen().join("\n");
  receipt.checks.liveRow = sawLive;
  receipt.checks.expandHint = sawHint;
  receipt.checks.expandedTrace = sawTraceGrowth;
  receipt.checks.settledBadge = V.settledBadge.test(settledScreen) || V.badgeSummary.test(settledScreen);

  tty.write("/subagents");
  await sleep(200);
  tty.write("\r");
  await waitIdle(1200, 8000);
  snap("viewer", true);
  receipt.checks.viewerOpened = V.viewerHeader.test(screen().join("\n"));
  tty.write("\x1b[B");
  await sleep(300);
  tty.write("\r");
  await waitIdle(1000, 6000);
  snap("viewer-detail", true);
  tty.write("\x1b");
  await sleep(400);
  tty.write("\x1b");
  await sleep(400);
  snap("after-viewer-close");
}

// ── scenario: parallel (loop hardening — one prompt, TWO children) ──────────
// Maps the `subagents` batch tool: the receipt proves the batch live feed
// (`subagents · k/2 running` + per-child rows) renders while BOTH children
// run, and that the settled batch header carries the CC vocabulary
// (tui-cc-parity-2 t03) in the SAME transcript that just showed the live feed.
async function scenarioParallel(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the subagents tool (the batch tool) NOW, exactly once, with EXACTLY two tasks, both with agentType set to hard-problem, both foreground: task 1: read README.md and report its first line. task 2: run `ls` and report the file count. Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");
  await sleep(1500);
  snap("submitted", true);

  let sawLive = false;
  let sawTwoRunning = false;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    const s = screen().join("\n");
    const running = V.liveMarker.test(s);
    if (running) {
      sawLive = true;
      // BOTH children in flight at once: the batch header's `k/2 running`
      // with k ≥ 2, or ≥2 distinct live Task( rows.
      const kOf2 = /(\d)\/2 running/.exec(s);
      const taskRows = new Set((s.match(/Task\([^)]*\)/g) ?? []).map((m) => m));
      if ((kOf2 && Number(kOf2[1]) >= 2) || taskRows.size >= 2) sawTwoRunning = true;
      if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
    }
    snap(running ? "running" : "after-run");
    if (!running && sawLive && Date.now() - lastByteAt > opts.quietMs) break;
  }
  snap("settled", true);
  const settledScreen = screen().join("\n");
  receipt.checks.liveRow = sawLive;
  receipt.checks.twoRunning = sawTwoRunning;
  receipt.checks.settledBadge =
    V.settledBadge.test(settledScreen) ||
    // t03 vocabulary: human duration + separator'd tokens on the batch header
    V.batchSettled.test(settledScreen);
}

// ── scenario: viewer (loop hardening — background run + follow drill-down) ──
// Dispatches a BACKGROUND subagent whose task runs LONG (sleep 120 — the
// predecessor's short task always settled before the abort could fire, so the
// abort check stayed best-effort), then operates the /subagents viewer like a
// human: open → enter the Running row → follow view with a live trace →
// abort via x/y → the run must LEAVE Running (aborted badge), closing the
// best-effort gap.
async function scenarioViewer(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the spawn_subagent tool NOW, exactly once, with agentType set to hard-problem and background set to true, task: run `sleep 120` in the current directory, then reply SLEPT-DONE. Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");
  await waitIdle(1200, 15000);
  snap("submitted", true);
  // background:true settles the CALL immediately with the backgroundRow glyph.
  // LATCH, not one-shot (allSettled lesson): the ⌛ row renders only while
  // that transcript region is on screen, and the parent's thinking time
  // varies a lot — check again inside every poll below.
  receipt.checks.backgroundRow = V.backgroundRow.test(screen().join("\n"));

  tty.write("/subagents");
  await sleep(200);
  tty.write("\r");
  await waitIdle(1200, 8000);
  snap("viewer", true);
  receipt.checks.viewerOpened = V.viewerHeader.test(screen().join("\n"));
  if (!receipt.checks.viewerOpened) return;

  // Move to the Running row and ENTER → follow view.
  tty.write("\x1b[B");
  await sleep(300);
  tty.write("\r");
  await waitIdle(1000, 6000);
  snap("follow", true);
  let sawFollowTrace = false;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    const s = screen().join("\n");
    // follow view signature: the header line (`▸ <model> • running • <dur>`)
    // plus a trace body (→/✓ markers) and/or a ticking elapsed.
    if (/• running •/.test(s) && (/[→✓] /.test(s) || /↳ /.test(s))) sawFollowTrace = true;
    if (!receipt.checks.backgroundRow && (V.backgroundRow.test(s) || V.bgLooseRow.test(s)))
      receipt.checks.backgroundRow = true;
    if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
    snap(sawFollowTrace ? "follow-live" : "follow");
    if (sawFollowTrace) break;
    if (Date.now() - lastByteAt > opts.quietMs && !/• running •/.test(s)) break;
  }
  receipt.checks.followTrace = sawFollowTrace;

  // Abort the run the way the viewer's own keymap does: back to list, select
  // the RUNNING entry, x, y. Two receipted traps live here: (1) 'x' only
  // aborts when the SELECTED entry is a running row — on any other row it
  // falls through to the type-to-filter input (first attempt typed 'x' into
  // the filter, 0 matches); (2) esc clears a filter before it closes the
  // viewer. So: clear any filter, walk up to the bg-marker live row, then x/y.
  // Deterministic reset: leave follow (esc — one press; if it happened to
  // close the viewer instead, reopening below fixes that too) and RE-OPEN
  // /subagents fresh. A fresh list puts the cursor on entry 0 = the live
  // running row (running entries render before completed ones), so the x/y
  // gesture below never races pane-render timing (receipted: the esc-from-
  // follow retry over-closed the viewer).
  tty.write("\x1b");
  await sleep(800);
  tty.write("/subagents");
  await sleep(200);
  tty.write("\r");
  await sleep(1200);
  if (/filter: "/.test(screen().join("\n"))) {
    tty.write("\x1b"); // esc clears the filter first
    await sleep(400);
  }
  const list = screen().join("\n");
  snap("viewer-list", true);
  const onRunning = /Running/.test(list);
  if (onRunning) {
    // Walk UP to the live row with the ARROW key — the viewer has no j/k
    // aliases (receipted: plain k lands in the filter), and the live row's
    // marker is `bg      ●` (multi-space), so match loosely.
    for (let i = 0; i < 4; i++) {
      const sel = screen().find((l) => l.includes("▶")) ?? "";
      if (/▶\s*bg\b/.test(sel)) break;
      tty.write("\x1b[A");
      await sleep(300);
    }
    tty.write("x");
    await sleep(400);
    snap("abort-confirm", true);
    receipt.checks.abortFlow = V.abortConfirm.test(readSnapText("abort-confirm") ?? "");
    tty.write("y");
    // The abort must take — judged by the DEFINITIVE observable: the abort
    // notification landing in the transcript (`status: aborted` / "Subagent
    // aborted by user"). UI FINDING (self-arc-4, recorded, not fixed here):
    // the viewer's Running section keeps rendering the aborted entry 15s+
    // after a successful kill (the elapsed freezes, the notification lands,
    // the stale row remains) — so "live row still present" proves nothing,
    // and neither does the bare word "aborted" (the transcript mentions it
    // only via the notification, which IS the evidence).
    let abortConfirmed = false;
    for (let i = 0; i < 8 && !abortConfirmed; i++) {
      await sleep(2500);
      const s = screen().join("\n");
      snap(i === 0 ? "after-abort" : `after-abort-${i + 1}`, true);
      if (V.abortConfirmedText.test(s)) abortConfirmed = true;
    }
    receipt.checks.abortConfirmed = abortConfirmed;
    // F-ui-2 fix check (self-arc-6): once the terminal status lands, the
    // aborted entry must LEAVE the Running section promptly — the stale row
    // used to linger 15s+ (six polls all showing it). The bottom log line
    // (single space before the dot) does not count; the live row has 2+ spaces.
    //
    // F-invalidate fix check (self-arc-7): phase 1 polls the OPEN viewer —
    // NO reopen kick. The registry→viewer onChange channel must repaint the
    // dialog the moment the run terminates (this used to freeze on its last
    // painted frame until a reopen forced a fresh mount — the self-arc-6
    // finding). A frozen frame here is a FAIL (staleRowGoneNoReopen). Phase
    // 2 only runs when phase 1 stayed stale: the close+reopen kick (fresh
    // mount re-reads views()) separates "render trigger missing" from "data
    // layer wrong" and stays as the staleRowGone diagnostic fallback.
    const staleGone = () => !V.bgLiveRow.test(screen().join("\n"));
    let staleRowGoneNoReopen = false;
    for (let i = 0; i < 8 && !staleRowGoneNoReopen; i++) {
      await sleep(2500);
      snap(`stale-row-${i + 1}`, true);
      if (staleGone()) staleRowGoneNoReopen = true;
    }
    receipt.checks.staleRowGoneNoReopen = staleRowGoneNoReopen;
    let staleRowGone = staleRowGoneNoReopen;
    if (!staleRowGone) {
      tty.write("\x1b");
      await sleep(600);
      tty.write("/subagents");
      await sleep(200);
      tty.write("\r");
      await sleep(1200);
      snap("stale-row-after-reopen", true);
      if (staleGone()) staleRowGone = true;
    }
    receipt.checks.staleRowGone = staleRowGone;
  }
  tty.write("\x1b");
  await sleep(400);
  snap("viewer-closed", true);
}

// ── scenario: catalog (self-arc-8 — CC parity: the parent ROUTES by the ────
// agentType catalog surfaced in the spawn tools' descriptions) ──────────────
// The dispatch prompt NEVER contains the type name. The parent must read the
// "Available agentTypes" catalog from the tool description and pick the type
// whose description offers deep analysis on tough problems using the big
// model (the scratch seed: hard-problem, bound to zai/glm-5.3). Proof of
// routing: a child row naming hard-problem WITH the glm-5.3 segment on ONE
// rendered line (actor+model segments never occur in parent prose), plus the
// standard background markers. All checks LATCHED in-loop (rows scroll out
// when the parent replies; settle markers are transient).
async function scenarioCatalog(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the spawn_subagent tool NOW, exactly once, with background set to true. Choose the agentType STRICTLY from the 'Available agentTypes' catalog in the spawn_subagent tool description: pick the type whose description offers deep analysis on tough problems using the big model — not explore, not plan. task: run `sleep 5` in the current directory, then reply CATALOG-ROUTED. Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");
  let backgroundRow = false;
  let catalogRouted = false;
  let settled = false;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    const s = screen().join("\n");
    if (!backgroundRow && (V.backgroundRow.test(s) || V.bgLiveRow.test(s))) backgroundRow = true;
    // Routed evidence, two shapes: (1) the F-actor-fixed row — actor name and
    // resolved model segment on ONE rendered line; (2) the child's streamed
    // def-prompt quote (`↳ You are the hard-problem analyst…`) — that line
    // exists ONLY when the spawn resolved the hard-problem def, so it is
    // conclusive even before the row carries the actor name.
    if (
      !catalogRouted &&
      (/hard-problem.*glm-5\.3|glm-5\.3.*hard-problem/.test(s) || /↳ You are the hard-problem analyst/.test(s))
    )
      catalogRouted = true;
    if (!settled && V.taskSettled.test(s)) settled = true;
    snap(backgroundRow ? (catalogRouted ? "routed" : "running") : "submitted", true);
    if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
    if (settled && catalogRouted) break;
  }
  receipt.checks.backgroundRow = backgroundRow;
  receipt.checks.catalogRouted = catalogRouted;
  receipt.checks.settled = settled;
}

// ── scenario: cc-parity (self-arc-12 t04 — the LIVE CC-parity receipts) ─────
// Two phases in one drive, both against REAL glm-5.3 children:
//   Phase 1 "Chain subagents" (CC sub-agents doc, Common patterns): the
//   parent spawns #1 (read secret-token.md → reply TOKEN: <value>), waits for
//   its notification, then spawns #2 with a task that EMBEDS the token; #2
//   replies CHAIN-VERIFIED. Latches: the token line, the re-embedded task
//   surface after settle 1, and CHAIN-VERIFIED.
//   Phase 2 code-reviewer (the doc's canonical read-only example): the parent
//   dispatches agentType cc-code-reviewer (seeded read-only, zai/glm-5.3) at
//   planted-bug.ts; latches: the def-prompt quote / actor row, a FINDING:
//   line, and the reviewed file byte-identical (sha256 before === after).
// All checks LATCHED in-loop on rendered truth; no viewer reopen. Gesture
// timing needs no child-evidence gating here (no abort gestures).
async function scenarioCcParity(): Promise<void> {
  // Deployed hosts render LATE — the shared boot gate (awaitBootRendered)
  // generalizes this scenario's original inline poll (self-arc-19 t01).
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  // Submit with verification: after Enter, the buffer must LEAVE the input —
  // evidence is the parent spinner (submission accepted; NOT child evidence,
  // which stays with the per-phase latches) or the phase's own latch. If
  // neither shows within 6s, the fresh dialog ate the Enter: re-press once,
  // latched on rendered truth (never a blind kick).
  const sendPrompt = async (text: string, evidenceRe: RegExp): Promise<void> => {
    tty.write(text);
    await sleep(300);
    tty.write("\r");
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(6000);
      const joined = screen().join("\n");
      if (evidenceRe.test(joined) || /Working/.test(joined)) return;
      tty.write("\r");
    }
  };

  const bugPath = path.join(opts.cwd, "planted-bug.ts");
  const sha256 = () => createHash("sha256").update(readFileSync(bugPath)).digest("hex");
  const bugShaBefore = sha256();

  // ── Phase 1: chain ──
  const chainPrompt =
    "Run a CHAIN of two subagents using the spawn_subagent tool. " +
    "Step 1: call spawn_subagent once, background true, task: `Read secret-token.md in the current directory and reply with its TOKEN line verbatim.` " +
    "Wait for step 1's task-notification. " +
    "Step 2: call spawn_subagent once, background true, with EXACTLY this task but replacing <value> with the token from step 1's result: " +
    "`Verify token <value> from the previous subagent's result: confirm it appears in secret-token.md and reply CHAIN-VERIFIED.` " +
    "Do not read the file yourself; do not use any other tool.";
  await sendPrompt(chainPrompt, /TOKEN: cc-parity-7f3a/);
  let chainChild1 = false;
  let chainEmbedded = false;
  let chainVerified = false;
  let phase1Settled = false;
  const t1 = Date.now();
  while (Date.now() - t1 < (opts.timeoutS * 1000) / 2) {
    await sleep(2000);
    const s = screen();
    const joined = s.join("\n");
    if (!chainChild1 && /TOKEN: cc-parity-7f3a/.test(joined)) chainChild1 = true;
    if (!phase1Settled && chainChild1 && /<task-notification>|status: done/.test(joined)) phase1Settled = true;
    // Embedded evidence: the SUBSTITUTED phrase "Verify token cc-parity-7f3a"
    // can only ever render from child 2's task surface (call line, live row,
    // or its task-label trace) — child 1's output reads "TOKEN: …" and the
    // parent's own prose quotes the template with the literal <value>. No
    // settle-ordering gate: the call line renders before child 1's
    // notification and scrolls out while the parent streams (rows scroll out
    // — the F-invalidate learning), so gating on phase1Settled misses it.
    if (!chainEmbedded && /Verify token cc-parity-7f3a/.test(joined)) chainEmbedded = true;
    if (phase1Settled && !chainVerified && /CHAIN-VERIFIED/.test(joined)) chainVerified = true;
    snap(
      chainVerified ? "chain-done" : chainEmbedded ? "chain-embedded" : chainChild1 ? "chain-1" : "chain-sent",
      true,
    );
    if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
    // Break only when BOTH latches hold: the parent ECHOES "CHAIN-VERIFIED"
    // (it dictated the reply) seconds before child 2's row renders the
    // embedded task — breaking on chainVerified alone quits the loop while
    // the embedding evidence is still a few renders away.
    if (chainVerified && chainEmbedded) break;
  }
  receipt.checks.chainChild1 = chainChild1;
  receipt.checks.chainEmbedded = chainEmbedded;
  receipt.checks.chainVerified = chainVerified;

  // ── Phase 2: read-only code-reviewer ──
  const reviewPrompt =
    "Call the spawn_subagent tool NOW, exactly once, with background set to true and agentType " +
    "cc-code-reviewer (from the 'Available agentTypes' catalog). task: `Review planted-bug.ts in the " +
    "current directory for logic defects and reply with a FINDING: line describing any defect you find.` " +
    "Do not review it yourself and use no other tool.";
  await sendPrompt(reviewPrompt, /cc-code-reviewer/);
  let reviewerRouted = false;
  let findingReported = false;
  let reviewSettled = false;
  const t2 = Date.now();
  while (Date.now() - t2 < (opts.timeoutS * 1000) / 2) {
    await sleep(2000);
    const joined = screen().join("\n");
    // Routed evidence: actor row with the type name, or the seeded def-prompt
    // quote (only exists when the spawn resolved cc-code-reviewer).
    if (
      !reviewerRouted &&
      (/cc-code-reviewer.*glm-5\.3|glm-5\.3.*cc-code-reviewer/.test(joined) ||
        /↳ You are the code reviewer/.test(joined))
    )
      reviewerRouted = true;
    if (!findingReported && /FINDING:/.test(joined)) findingReported = true;
    if (!reviewSettled && V.taskSettled.test(joined)) reviewSettled = true;
    snap(findingReported ? "finding" : reviewerRouted ? "reviewer-routed" : "review-sent", true);
    if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
    if (reviewSettled && reviewerRouted && findingReported) break;
  }
  receipt.checks.reviewerRouted = reviewerRouted;
  receipt.checks.findingReported = findingReported;
  receipt.checks.reviewSettled = reviewSettled;
  // Read-only proof, belt and braces: the reviewed file is byte-identical.
  receipt.checks.fileUnchanged = sha256() === bugShaBefore;
}

// ── scenario: workflow (self-arc-10 t03 — the unified-surface receipt) ──────
// Drives a REAL ultracode workflow run in the background and then aborts its
// shared registry row through the /subagents viewer's x-key — proving the
// bridge end-to-end: the wf: row appears with the `wf` badge and an ABORTABLE
// lever (t02), the viewer confirm fires, and the row reads aborted (t01's
// stop → markLiveStatus) with NO reopen. All latches gated on CHILD evidence
// (the `wf_receipt · k/2 agents` preview only exists once the workflow engine
// registered agents) — the parent's spinner fires long before.
async function scenarioWorkflow(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const script =
    "export const meta = { name: 'wf_receipt', description: 'receipt drill', phases: [{ title: 'Work' }] }\\nphase('Work')\\nconst a = await agent('Reply with exactly WF-OK and nothing else.')\\nconst b = await agent('Run sleep 8 in the shell, then reply SLEPT-WF.')\\nreturn { a, b }";
  const prompt =
    "Call the workflow tool NOW, exactly once, with background true (the default) and this script as the script parameter: " +
    script +
    " Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");

  let wfRow = false;
  let gestured = false;
  let wfAbortFlow = false;
  let wfAbortConfirmed = false;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    let s = screen().join("\n");
    // Child evidence: the k/N counter and the panel-glyph-prefixed row only
    // render once the workflow engine registered its agents (receipted — the
    // panel shape is `wf_receipt · k/2 agents · Work` with the panel row
    // glyph (see UI_VOCAB.wfGlyph/wfAgentsCounter), not the preview form).
    if (!wfRow && (V.wfAgentsCounter.test(s) || (V.wfGlyph.test(s) && s.includes("wf_receipt")))) {
      wfRow = true;
      receipt.checks.wfRow = true;
    }
    if (!wfRow) {
      snap("submitted");
      continue;
    }
    // ── the abort gesture on the OPEN viewer (once, child evidence latched) ──
    if (!gestured) {
      gestured = true;
      tty.write("/subagents");
      await sleep(200);
      tty.write("\r");
      await sleep(1200);
      // fresh scratch session → the wf row is the only Running entry → cursor
      // starts on it; wait briefly for the row to render before pressing x.
      for (let i = 0; i < 6; i++) {
        if (/workflow/.test(screen().join("\n"))) break;
        await sleep(500);
      }
      snap("wf-viewer", true);
      tty.write("x");
      await sleep(500);
      snap("wf-abort-confirm", true);
      wfAbortFlow = V.abortConfirm.test(readSnapText("wf-abort-confirm") ?? "");
      receipt.checks.wfAbortFlow = wfAbortFlow;
      tty.write("y");
      await sleep(500);
      // STAY in the viewer — the registry's change channel must repaint the
      // aborted row with no reopen (F-invalidate discipline, now on wf rows).
      continue;
    }
    // ── latched post-abort observation (open viewer, then transcript) ──
    if (!wfAbortConfirmed) {
      const confirmGone = !V.abortConfirm.test(s);
      const terminal = /⊘|aborted/.test(s);
      if (confirmGone && terminal) wfAbortConfirmed = true;
    }
    s = screen().join("\n");
    snap(wfAbortConfirmed ? "wf-aborted" : "wf-aborting", true);
    if (wfAbortConfirmed && Date.now() - lastByteAt > opts.quietMs) break;
  }
  receipt.checks.wfRow = wfRow;
  receipt.checks.wfAbortFlow = wfAbortFlow;
  receipt.checks.wfAbortConfirmed = wfAbortConfirmed;
  if (!wfAbortConfirmed) {
    const s = screen().join("\n");
    receipt.checks.wfAbortConfirmed = /status: aborted|Workflow .* (aborted|stopped)|wf_receipt.*abort/i.test(s);
  }
}

// ── scenario: wf-pause (self-arc-11 t01 — pause/resume on the shared row) ───
// Drives a real background workflow, pauses it from the /workflows navigator
// (`p` — the keymap already existed), and proves the arc-11 lifecycle on the
// SHARED surface: the /subagents wf row reads `paused` and STAYS (the pre-t01
// code evicted it on the pause unwind), then resume runs it to completion.
// Every latch is gated on child evidence; the /subagents observation happens
// on the OPEN viewer (no reopen); all sends are wall-clock paced.
async function scenarioWfPause(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const script =
    "export const meta = { name: 'wf_pause', description: 'pause drill', phases: [{ title: 'Work' }] }\\nphase('Work')\\nconst a = await agent('Reply with exactly WF-OK and nothing else.')\\nconst b = await agent('Run sleep 12 in the shell, then reply SLEPT-PAUSE.')\\nreturn { a, b }";
  const prompt =
    "Call the workflow tool NOW, exactly once, with background true (the default) and this script as the script parameter: " +
    script +
    " Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");

  let wfRow = false;
  let runId = "";
  let pausedNavigator = false;
  let pausedSharedRow = false;
  let resumedRow = false;
  let completed = false;
  let phase = 0; // 0 wait-start · 1 pause gesture · 2 observe shared · 3 resume · 4 wait completion
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    let s = screen().join("\n");
    if (!wfRow) {
      const m = /Run ID: ([a-z0-9-]+)/.exec(s);
      if (m) runId = m[1] ?? "";
      if (V.wfAgentsCounter.test(s) || (V.wfGlyph.test(s) && s.includes("wf_pause"))) {
        wfRow = true;
        receipt.checks.wfRow = true;
      } else {
        snap("submitted");
        continue;
      }
    }
    if (phase === 0) {
      phase = 1;
      tty.write("/workflows");
      await sleep(200);
      tty.write("\r");
      await sleep(1500);
      tty.write("p"); // navigator keymap: pause the selected run
      await sleep(1800);
      s = screen().join("\n");
      snap("pause-navigator", true);
      pausedNavigator = /⏸|paused/i.test(s);
      receipt.checks.pausedNavigator = pausedNavigator;
      tty.write("\x1b"); // close the navigator
      await sleep(600);
      tty.write("/subagents");
      await sleep(200);
      tty.write("\r");
      await sleep(1500);
      phase = 2;
      continue;
    }
    if (phase === 2) {
      s = screen().join("\n");
      // The OPEN viewer (no reopen): the wf row must read paused — arc-11's
      // keep-paused-row lifecycle rendered through the change channel.
      // Structural latch: the paused glyph (glyphFor("paused"), UI_VOCAB
      // .pausedGlyph) renders ONLY
      // on a paused row — parent prose naming "workflow" + "paused" cannot
      // fake it (receipted: prose-pollution was possible in the first draft).
      const line = screen().find((l) => V.pausedGlyph.test(l) && /(workflow|wf_pause)/.test(l));
      if (line) pausedSharedRow = true;
      snap("paused-shared", true);
      receipt.checks.pausedSharedRow = pausedSharedRow;
      if (pausedSharedRow || !V.viewerHeader.test(s)) {
        tty.write("\x1b");
        await sleep(600);
        if (runId) {
          tty.write(`/workflows resume ${runId}`);
          await sleep(200);
          tty.write("\r");
        }
        phase = 3;
      }
      continue;
    }
    if (phase === 3) {
      s = screen().join("\n");
      // Resumed: the panel row back to live (glyph / k-of-N counter) — or the
      // resume notification landed in the transcript.
      if ((V.wfGlyph.test(s) && s.includes("wf_pause")) || V.wfAgentsCounter.test(s) || /resumed/i.test(s)) {
        resumedRow = true;
        receipt.checks.resumedRow = true;
        phase = 4;
      } else {
        snap("resuming");
        continue;
      }
    }
    if (!completed && /✓ Background workflow "wf_pause" finished|finished \(2 agents/.test(s)) {
      completed = true;
      receipt.checks.completed = true;
    }
    snap(completed ? "completed" : "running-again", true);
    if (completed && Date.now() - lastByteAt > opts.quietMs) break;
  }
  receipt.checks.wfRow = wfRow;
  receipt.checks.pausedNavigator = pausedNavigator;
  receipt.checks.pausedSharedRow = pausedSharedRow;
  receipt.checks.resumedRow = resumedRow;
  receipt.checks.completed = completed;
}

// ── scenario: steer (self-arc-22 t02 — F-steer-1 fix proof) ──────────────────
// Background NAMED child with a LONG tool call (sleep 120 → a wide tool-
// execution window); the parent steers it via list_subagent_runs action=steer
// while the tool is still running. The receipt proves the honest reply lands
// AND the steered marker reaches the child's final output — the exact window
// where arc-19's r2 drill lost the guidance.
async function scenarioSteer(): Promise<void> {
  await awaitBootRendered(screen, 90_000);
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Do EXACTLY this, in order. 1) Call spawn_subagent ONCE with: name='steer-drill', background=true, " +
    "task='Run sleep 120 in the shell. When it finishes, check whether a message containing STEER-ARC22-OK arrived for you; " +
    "if it did, reply with exactly STEER-ARC22-OK. Otherwise reply SLEPT-NO-STEER.' Note the run id. " +
    "2) IMMEDIATELY call list_subagent_runs with action='steer', the run id from step 1, and message='Do not run sleep. " +
    "Reply with exactly STEER-ARC22-OK'. Report the tool result verbatim. " +
    "3) Call list_subagent_runs with action='wait', the run id, timeoutMs=180000, and report the child's final output verbatim.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");

  let sawSteerReply = false;
  let sawMarker = false;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    const s = screen().join("\n");
    // The steer verb's honest reply (self-arc-22 t02): queued-after-tool OR
    // steered-into-exchange — either proves the verb executed. The marker
    // latch is the settled summary line ONLY (↳ + marker): the PROMPT echo
    // also contains the marker string and would false-positive forever
    // (receipted: the first steer-drill run latched the echo while the child
    // reported it never received anything).
    if (/queued and will be delivered right after the current tool|steered into run /.test(s)) sawSteerReply = true;
    if (/↳[^\n]*STEER-ARC22-OK/.test(s)) sawMarker = true;
    if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
    snap(sawMarker ? "marker" : sawSteerReply ? "steered" : "running", true);
    if (sawSteerReply && sawMarker && Date.now() - lastByteAt > opts.quietMs) break;
  }
  receipt.checks.steerReply = sawSteerReply;
  receipt.checks.markerInOutput = sawMarker;
}

// ── scenario: agents (agents-manager t03 — drive the /agents manager) ────────
// Pure-local drill (no LLM round-trip): open /agents over the seeded probe
// definition, read its detail, CREATE a second definition through the form,
// EDIT it (ctrl+u clears the description), then DELETE it with the y/N
// confirm. Also the live shadow check: a host builtin claiming /agents would
// make dialogOpened render something that is NOT this dialog.
async function scenarioAgents(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  tty.write("/agents");
  await sleep(200);
  tty.write("\r");
  await sleep(1200); // real wall-clock: the dialog mounts + re-renders here
  await waitIdle(800, 8000);
  snap("agents-list", true);
  const list = screen().join("\n");
  receipt.checks.dialogOpened = V.agentsDialogHeader.test(list);
  receipt.checks.seededRowRendered = /probe {2}·/.test(list) && /seeded by tui-drive/.test(list);
  if (!receipt.checks.dialogOpened) return;

  // Project group sorts A→Z: hard-problem seeds before probe, so move down
  // one row to probe before entering the detail. A freshly-mounted dialog can
  // eat the FIRST key (observed live: the enter landed on the composer and
  // the list stayed) — retry, PACED with real sleeps (waitIdle returns
  // instantly on a static dialog: no bytes = already quiet), and only enter
  // while the list footer is showing, exactly what a human does when a
  // keypress is swallowed.
  tty.write("j"); // hard-problem → probe
  await sleep(400);
  const inDetail = (): boolean => /prompt:/.test(screen().join("\n"));
  for (let tries = 0; tries < 4 && !inDetail(); tries++) {
    await sleep(700);
    if (/enter detail/.test(screen().join("\n"))) tty.write("\r");
  }
  await sleep(700);
  snap("agents-detail", true);
  const detail = screen().join("\n");
  receipt.checks.detailPrompt = inDetail() && /Do the probe/.test(detail);
  tty.write("\x1b"); // detail → list
  await sleep(600);
  // If the retry loop exhausted with the dialog still in list view, the rest
  // of the drill would act on the WRONG row — bail honestly instead.
  if (!receipt.checks.detailPrompt) return;

  // CREATE: c → name → tab → description → enter (saves to project scope).
  tty.write("c");
  await sleep(400);
  snap("agents-form", true);
  receipt.checks.formOpened = /New agentType/.test(screen().join("\n"));
  if (!receipt.checks.formOpened) return;
  tty.write("tui-made-two");
  await sleep(200);
  tty.write("\t");
  await sleep(200);
  tty.write("made by tui-drive");
  await sleep(200);
  tty.write("\r");
  await waitIdle(1500, 10000);
  snap("agents-created", true);
  const afterCreate = screen().join("\n");
  receipt.checks.created = /saved/.test(afterCreate) && /tui-made-two {2}·/.test(afterCreate);

  // EDIT: probe < tui-made-two in the project group → one `j` from probe lands
  // on it. ctrl+u clears the preloaded description before typing the new one.
  tty.write("j");
  await sleep(300);
  tty.write("e");
  await sleep(400);
  snap("agents-edit-form", true);
  const editForm = screen().join("\n");
  receipt.checks.editPreloaded = /Edit tui-made-two/.test(editForm) && /made by tui-drive/.test(editForm);
  tty.write("\t"); // name → description
  await sleep(200);
  tty.write("\x15"); // ctrl+u — clear the field
  await sleep(200);
  tty.write("edited by tui-drive");
  await sleep(200);
  tty.write("\r");
  await waitIdle(1500, 10000);
  snap("agents-edited", true);
  receipt.checks.edited = /edited by tui-drive/.test(screen().join("\n"));

  // DELETE: d → the y/N confirm → y. The status line legitimately keeps the
  // name ("deleted <path>"), so the gone-check filters the status line out.
  tty.write("d");
  await sleep(400);
  snap("agents-confirm", true);
  receipt.checks.deleteConfirm = V.deleteConfirm.test(screen().join("\n"));
  tty.write("y");
  await waitIdle(1500, 10000);
  snap("agents-deleted", true);
  const afterDelete = screen()
    .filter((l) => !l.includes("deleted"))
    .join("\n");
  receipt.checks.deleted = !/tui-made-two/.test(afterDelete);

  tty.write("\x1b"); // close the dialog
  await sleep(400);
  snap("agents-closed", true);
}

// ── scenario: reload (definition live-reload proof) ──────────────────────────
// The registry is re-read from disk on EVERY spawn (no session cache — pinned
// by agent-def-reload.test.ts), so an edit to .pi/agents/*.md takes effect on
// the NEXT dispatch without restarting the session. Prove it end-to-end:
// spawn with the def's v1 prompt (child replies RELOAD-ONE), rewrite the def
// to v2 on disk, spawn again — the second child must reply RELOAD-TWO. A
// session-cached registry would replay RELOAD-ONE and fail the receipt. The
// child's reply lands on the settled `↳ <reply>` summary line (receipted).
async function scenarioReload(): Promise<void> {
  // A freshly-created version dir can take a while to first render (deployed
  // boot) — the shared boot gate (awaitBootRendered) generalizes this
  // scenario's original inline poll (self-arc-19 t01).
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const defPath = path.join(opts.cwd, ".pi", "agents", "hard-problem.md");
  const writeDef = (marker: string): void =>
    writeFileSync(
      defPath,
      [
        "---",
        "name: hard-problem",
        "description: Deep analysis on hard problems — bound to the big model.",
        "model: zai/glm-5.3",
        "---",
        `Reply with exactly ${marker} and nothing else.`,
      ].join("\n"),
    );

  const spawnAndSettle = async (): Promise<void> => {
    tty.write(
      "Call the spawn_subagent tool NOW, exactly once, foreground (background not set), with agentType set to hard-problem, task: follow your instructions exactly. Do not answer anything yourself and use no other tool.",
    );
    await sleep(300);
    tty.write("\r");
    let sawLive = false;
    const t0 = Date.now();
    while (Date.now() - t0 < opts.timeoutS * 1000) {
      await sleep(2000);
      const s = screen().join("\n");
      const running = V.liveMarker.test(s);
      if (running) sawLive = true;
      snap(running ? "running" : "after-run");
      if (!running && sawLive && Date.now() - lastByteAt > opts.quietMs) break;
    }
  };

  // Run 1 — v1 prompt. The marker exists ONLY in the def file, so its
  // appearance on screen (compact ↳ summary line, parent narration, or code
  // fence — both shapes receipted) proves the child ran with the v1 prompt.
  writeDef("RELOAD-ONE");
  await spawnAndSettle();
  snap("settled-one", true);
  receipt.checks.reloadOne = /RELOAD-ONE/.test(screen().join("\n"));

  // Rewrite the definition on disk — what a human editor (or the /agents
  // manager's own write path) does — then spawn again. No restart, no cache
  // invalidation: the tool's per-spawn load must pick up v2.
  writeDef("RELOAD-TWO");
  await spawnAndSettle();
  snap("settled-two", true);
  receipt.checks.reloadTwo = /RELOAD-TWO/.test(screen().join("\n"));
}

// ── scenario: swarm (multi-parallel — THREE children through the batch tool) ─
// The parallel scenario proved 2 children in flight; swarm raises it to 3 and
// asserts REAL concurrency (the batch header's k/3 counter reaching ≥2 while
// children still run, or ≥3 distinct live rows) plus a full settle: every one
// of the three children ends ✓ done, each routed through agentType
// hard-problem (glm-5.3 via childModelIsGlm53).
async function scenarioSwarm(): Promise<void> {
  await awaitBootRendered(screen, 90_000); // self-arc-19 t01 (map D4) — all scenarios
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  // self-arc-9 t03: task 1 carries a sleep so the abort window is real — the
  // two read-only tasks settle in seconds, and a batch that finishes before
  // the gesture lands would turn the abort checks into honest fails.
  const prompt =
    "Call the subagents tool (the batch tool) NOW, exactly once, with EXACTLY three tasks, all with agentType set to hard-problem, all foreground: task 1: run `sleep 10` in the current directory, then reply SLEPT-1. task 2: run `ls` and report the file count. task 3: read sample.ts and report the number of exported functions. Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");
  await sleep(1500);
  snap("submitted", true);

  let sawLive = false;
  let sawThreeConcurrent = false;
  let gestured = false;
  let batchAbortConfirmed = false;
  let allChildrenTerminal = false;
  const t0 = Date.now();
  while (Date.now() - t0 < opts.timeoutS * 1000) {
    await sleep(2000);
    const s = screen().join("\n");
    const running = V.liveMarker.test(s);
    if (!running) {
      snap("after-run");
      if (sawLive && Date.now() - lastByteAt > opts.quietMs) break;
      continue;
    }
    sawLive = true;
    // True concurrency: the batch header's k/3 counter with k ≥ 2 while
    // children still run, or ≥3 distinct live Task rows.
    const kOf3 = /(\d)\/3 running/.exec(s);
    const taskRows = new Set((s.match(/Task\([^)]*\)/g) ?? []).map((m) => m));
    if ((kOf3 && Number(kOf3[1]) >= 2) || taskRows.size >= 3) sawThreeConcurrent = true;
    if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;

    // ── the abort gesture: FIRST CHILD evidence, on the OPEN viewer ──
    // (The parent's `Working…` spinner fires long before the batch dispatches
    // — receipted: the viewer opened on an empty registry and the gesture
    // whiffed. Gate on the batch header counter or a live Task row: those
    // exist only once the children are registered. L3: the freshly-mounted
    // dialog eats the first keypress — pace every send with real sleeps; the
    // viewer's Running section renders the batch header FIRST, so entry 0 IS
    // the header: no arrow walk needed.)
    if (!gestured && (kOf3 || taskRows.size >= 1)) {
      gestured = true;
      tty.write("/subagents");
      await sleep(200);
      tty.write("\r");
      await sleep(1200);
      // The dialog may beat the registration by a beat — wait until the
      // batch section renders (or a bounded number of polls gives up).
      for (let i = 0; i < 8; i++) {
        if (/Running|batch/.test(screen().join("\n"))) break;
        await sleep(500);
      }
      snap("swarm-viewer", true);
      tty.write("x");
      await sleep(500);
      snap("swarm-abort-confirm", true);
      receipt.checks.batchAbortFlow = V.abortAllConfirm.test(readSnapText("swarm-abort-confirm") ?? "");
      tty.write("y");
      await sleep(500);
      // STAY in the viewer: the registry's onChange channel repaints the open
      // dialog on every terminal transition — observing it here re-proves
      // F-invalidate under batch abort (the no-reopen discipline).
      continue;
    }

    // ── latched post-abort observation (open viewer, NO reopen) ──
    if (!batchAbortConfirmed) {
      const viewerOpen = V.viewerHeader.test(s);
      const confirmGone = !V.abortAllConfirm.test(s);
      const terminalEvidence = /⊘|✗|aborted/.test(s) || /0\/3 running/.test(s);
      if (viewerOpen && confirmGone && terminalEvidence) batchAbortConfirmed = true;
    }
    // All children terminal: ≥3 terminal child rows or a 0-running header in
    // the viewer, OR (after esc) the transcript's settled batch line / abort
    // notifications — rows scroll, so any single sample latches.
    if (!allChildrenTerminal) {
      const terminalRows = (s.match(/⊘|✗/g) ?? []).length;
      if (terminalRows >= 3 || /0\/3 running/.test(s) || V.abortConfirmedText.test(s) || V.batchSettled.test(s))
        allChildrenTerminal = true;
    }
    snap(batchAbortConfirmed ? "aborted" : "aborting", true);
    if (batchAbortConfirmed && allChildrenTerminal) break;
    if (Date.now() - lastByteAt > opts.quietMs && !V.viewerHeader.test(s) && allChildrenTerminal) break;
  }
  snap("settled", true);
  const settledScreen = screen().join("\n");
  receipt.checks.liveRow = sawLive;
  receipt.checks.threeConcurrent = sawThreeConcurrent;
  receipt.checks.batchAbortConfirmed = batchAbortConfirmed;
  // Terminal evidence may have scrolled while we were still latching the
  // confirm — the settled screen gets one more chance (LATCHED, never reset).
  if (!allChildrenTerminal) {
    const terminalRows = (settledScreen.match(/⊘|✗/g) ?? []).length;
    allChildrenTerminal =
      terminalRows >= 3 || V.abortConfirmedText.test(settledScreen) || V.batchSettled.test(settledScreen);
  }
  receipt.checks.allChildrenTerminal = allChildrenTerminal;
}

/** Read a snapshot file back (the abort-confirm check needs the confirm text
 *  AT the moment it was shown — the screen has moved on by check time).
 *  LOOP FINDING (self-arc-4): this helper built the filename WITHOUT the
 *  `snap-` prefix, so it read NOTHING since #2190 — abortFlow was a
 *  permanent false false, masked by a plausible "the run finished first"
 *  diagnosis. Always re-check these helpers against real filenames. */
function readSnapText(label: string): string | undefined {
  try {
    const name = `snap-${String(snapN).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_")}.txt`;
    return readFileSync(path.join(opts.out, name), "utf8");
  } catch {
    return undefined;
  }
}

try {
  if (opts.scenario === "dispatch") await scenarioDispatch();
  else if (opts.scenario === "parallel") await scenarioParallel();
  else if (opts.scenario === "viewer") await scenarioViewer();
  else if (opts.scenario === "agents") await scenarioAgents();
  else if (opts.scenario === "reload") await scenarioReload();
  else if (opts.scenario === "swarm") await scenarioSwarm();
  else if (opts.scenario === "catalog") await scenarioCatalog();
  else if (opts.scenario === "workflow") await scenarioWorkflow();
  else if (opts.scenario === "wf-pause") await scenarioWfPause();
  else if (opts.scenario === "cc-parity") await scenarioCcParity();
  else if (opts.scenario === "steer") await scenarioSteer();
  else throw new Error(`unknown scenario: ${opts.scenario}`);
} catch (e) {
  // Reviewer finding #7: a crashed scenario must still leave a receipt — a
  // silent exit discards the failure evidence the self-evolve loop reads.
  receipt.checks.scenarioError = false;
  receipt.snaps = snapN;
  receipt.modelLine = modelLine();
  writeFileSync(
    path.join(opts.out, "receipt.json"),
    `${JSON.stringify({ ...receipt, error: String((e as Error)?.message ?? e) }, null, 2)}\n`,
  );
  console.error(`[tui-drive] CRASH — ${(e as Error)?.message ?? e} (receipt still written)`);
} finally {
  tty.write("\x03");
  await sleep(600);
  tty.write("\x03");
  await sleep(800);
  try {
    proc.kill(9);
  } catch {
    /* already gone */
  }
}

receipt.finishedAt = new Date().toISOString();
receipt.bytesSeen = bytesSeen;
receipt.snaps = snapN;
receipt.modelLine = modelLine();
receipt.checks.modelIsGlm = opts.expectModel.test(receipt.modelLine);
// Required checks are per scenario — dispatch/parallel settle on badges and
// viewer parity; viewer drills the follow/abort flow instead of a settle.
const requiredByScenario: Record<Opts["scenario"], string[]> = {
  dispatch: ["booted", "liveRow", "settledBadge", "viewerOpened", "childModelIsGlm53", "sawTaskLine", "liveModelSlot"],
  parallel: ["booted", "liveRow", "twoRunning", "settledBadge", "childModelIsGlm53"],
  viewer: [
    "booted",
    "backgroundRow",
    "viewerOpened",
    "followTrace",
    "childModelIsGlm53",
    "abortFlow",
    "abortConfirmed",
    "staleRowGoneNoReopen",
    "staleRowGone",
  ],
  agents: [
    "booted",
    "dialogOpened",
    "seededRowRendered",
    "detailPrompt",
    "formOpened",
    "created",
    "editPreloaded",
    "edited",
    "deleteConfirm",
    "deleted",
  ],
  reload: ["booted", "reloadOne", "reloadTwo"],
  catalog: ["booted", "backgroundRow", "catalogRouted", "settled", "childModelIsGlm53"],
  workflow: ["booted", "wfRow", "wfAbortFlow", "wfAbortConfirmed"],
  "wf-pause": ["booted", "wfRow", "pausedNavigator", "pausedSharedRow", "resumedRow", "completed"],
  steer: ["booted", "steerReply", "markerInOutput", "childModelIsGlm53"],
  swarm: [
    "booted",
    "liveRow",
    "threeConcurrent",
    "batchAbortFlow",
    "batchAbortConfirmed",
    "allChildrenTerminal",
    "childModelIsGlm53",
  ],
  "cc-parity": [
    "booted",
    "chainChild1",
    "chainEmbedded",
    "chainVerified",
    "reviewerRouted",
    "findingReported",
    "fileUnchanged",
    "childModelIsGlm53",
  ],
};
const required = requiredByScenario[opts.scenario] ?? [];
// expandedTrace + modelIsGlm are PARITY checks — reported, and required only
// when the zai key was available (lm-studio fallback runs are still useful
// receipts, but they exercise a weaker model). expandHint is REPORTED ONLY
// since the model-policy round: the hint renders only when a COLLAPSED trace
// has ≥2 lines, and the agentType call row renders one line pre-expansion —
// the affordance itself was receipted in the earlier rounds.
const parity = opts.scenario === "dispatch" ? (["expandedTrace", "modelIsGlm"] as const) : (["modelIsGlm"] as const);
const missing = required.filter((k) => !receipt.checks[k]);
const parityMissing = zaiKey ? parity.filter((k) => !receipt.checks[k]) : [];
receipt.pass = missing.length === 0 && parityMissing.length === 0;

writeFileSync(path.join(opts.out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  `TUI_DRIVE ${JSON.stringify({ pass: receipt.pass, checks: receipt.checks, modelLine: receipt.modelLine, out: opts.out })}`,
);
console.error(
  `[tui-drive] ${receipt.pass ? "PASS" : "FAIL"} — snaps=${snapN} bytes=${bytesSeen}` +
    (missing.length ? ` missing:${missing.join(",")}` : "") +
    (parityMissing.length ? ` parity-missing:${parityMissing.join(",")}` : "") +
    ` — receipt: ${path.join(opts.out, "receipt.json")}`,
);
process.exit(receipt.pass ? 0 : 1);
