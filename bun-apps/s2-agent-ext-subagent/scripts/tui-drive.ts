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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
  scenario: "dispatch" | "parallel" | "viewer";
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
// (`ls` + read + count exports) has something real to do.
if (!opts.cwd) {
  opts.cwd = mkdtempSync(path.join(os.tmpdir(), "s2-tui-probe-"));
  writeFileSync(path.join(opts.cwd, "sample.ts"), "export const a = 1\nexport function b() { return a + 1 }\n");
  writeFileSync(path.join(opts.cwd, "README.md"), "# tui-drive scratch\n");
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
  console.error("error: Bun.Terminal unavailable — Bun ≥1.3.5 required (repo pins 1.4.0; is PATH's bun stale?)");
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
};

async function scenarioDispatch(): Promise<void> {
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the spawn_subagent tool NOW, exactly once, foreground (background not set), with task: run `ls -la` in the current directory, then read sample.ts, then report the number of exported functions and the file count. Do not answer anything yourself and use no other tool.";
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
    const running = /Working\.\.\.|esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s);
    if (running) {
      sawLive = true;
      if (/· ctrl\+o to expand/.test(s)) sawHint = true;
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
  receipt.checks.settledBadge =
    /✓ done|✗ failed|⏱ timedout|⛔ budget|⏹ turns|⊘ aborted/.test(settledScreen) ||
    /↳ .* · [0-9,]+ tokens · /.test(settledScreen);

  tty.write("/subagents");
  await sleep(200);
  tty.write("\r");
  await waitIdle(1200, 8000);
  snap("viewer", true);
  receipt.checks.viewerOpened = screen().join("\n").includes("Subagent runs");
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
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the subagents tool (the batch tool) NOW, exactly once, with EXACTLY two tasks, both foreground: task 1: read README.md and report its first line. task 2: run `ls` and report the file count. Do not answer anything yourself and use no other tool.";
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
    const running = /Working\.\.\.|esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s);
    if (running) {
      sawLive = true;
      // BOTH children in flight at once: the batch header's `k/2 running`
      // with k ≥ 2, or ≥2 distinct live Task( rows.
      const kOf2 = /(\d)\/2 running/.exec(s);
      const taskRows = new Set((s.match(/Task\([^)]*\)/g) ?? []).map((m) => m));
      if ((kOf2 && Number(kOf2[1]) >= 2) || taskRows.size >= 2) sawTwoRunning = true;
    }
    snap(running ? "running" : "after-run");
    if (!running && sawLive && Date.now() - lastByteAt > opts.quietMs) break;
  }
  snap("settled", true);
  const settledScreen = screen().join("\n");
  receipt.checks.liveRow = sawLive;
  receipt.checks.twoRunning = sawTwoRunning;
  receipt.checks.settledBadge =
    /✓ done|✗ failed|⏱ timedout|⛔ budget|⏹ turns|⊘ aborted/.test(settledScreen) ||
    // t03 vocabulary: human duration + separator'd tokens on the batch header
    /subagents batch \([^)]*\) — [0-9]+s(?! elapsed)/.test(settledScreen);
}

// ── scenario: viewer (loop hardening — background run + follow drill-down) ──
// Dispatches a BACKGROUND subagent (the spawn returns immediately), then
// operates the /subagents viewer like a human: open → enter the Running row →
// follow view must show a live trace with ticking elapsed → abort via x/y →
// viewer closes.
async function scenarioViewer(): Promise<void> {
  await waitIdle(2500, 45000);
  snap("boot", true);
  receipt.checks.booted = screen().length > 0;

  const prompt =
    "Call the spawn_subagent tool NOW, exactly once, with background set to true, task: read README.md and report its first line. Do not answer anything yourself and use no other tool.";
  tty.write(prompt);
  await sleep(300);
  tty.write("\r");
  await waitIdle(1200, 15000);
  snap("submitted", true);
  // background:true settles the CALL immediately with a `⌛ running` row.
  receipt.checks.backgroundRow = /⌛ running/.test(screen().join("\n"));

  tty.write("/subagents");
  await sleep(200);
  tty.write("\r");
  await waitIdle(1200, 8000);
  snap("viewer", true);
  receipt.checks.viewerOpened = screen().join("\n").includes("Subagent runs");
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
    snap(sawFollowTrace ? "follow-live" : "follow");
    if (sawFollowTrace) break;
    if (Date.now() - lastByteAt > opts.quietMs && !/• running •/.test(s)) break;
  }
  receipt.checks.followTrace = sawFollowTrace;

  // Abort the run the way the viewer's own keymap does: back to list, x, y.
  tty.write("\x1b"); // follow → list
  await sleep(400);
  const list = screen().join("\n");
  snap("viewer-list", true);
  const onRunning = /Running/.test(list);
  if (onRunning) {
    tty.write("x");
    await sleep(400);
    snap("abort-confirm", true);
    tty.write("y");
    await sleep(800);
    snap("after-abort", true);
    receipt.checks.abortFlow = /Abort this subagent\? y\/N/.test(readSnapText("abort-confirm") ?? "");
  }
  tty.write("\x1b");
  await sleep(400);
  snap("viewer-closed", true);
}

/** Read a snapshot file back (the abort-confirm check needs the confirm text
 *  AT the moment it was shown — the screen has moved on by check time). */
function readSnapText(label: string): string | undefined {
  try {
    const name = `${String(snapN).padStart(2, "0")}-${label.replace(/[^\w-]+/g, "_")}.txt`;
    return readFileSync(path.join(opts.out, name), "utf8");
  } catch {
    return undefined;
  }
}

try {
  if (opts.scenario === "dispatch") await scenarioDispatch();
  else if (opts.scenario === "parallel") await scenarioParallel();
  else if (opts.scenario === "viewer") await scenarioViewer();
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
  dispatch: ["booted", "liveRow", "settledBadge", "viewerOpened"],
  parallel: ["booted", "liveRow", "twoRunning", "settledBadge"],
  viewer: ["booted", "backgroundRow", "viewerOpened", "followTrace"],
};
const required = requiredByScenario[opts.scenario] ?? [];
// expandHint + expandedTrace + modelIsGlm are PARITY checks — reported, and
// required only when the zai key was available (lm-studio fallback runs are
// still useful receipts, but they exercise a weaker model).
const parity =
  opts.scenario === "dispatch" ? (["expandHint", "expandedTrace", "modelIsGlm"] as const) : (["modelIsGlm"] as const);
const missing = required.filter((k) => !receipt.checks[k]);
const parityMissing = zaiKey ? parity.filter((k) => !receipt.checks[k]) : [];
receipt.pass = missing.length === 0 && parityMissing.length === 0;

writeFileSync(path.join(opts.out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
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
