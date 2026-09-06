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
  scenario: "dispatch" | "parallel" | "viewer" | "agents" | "reload";
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

/** The child's model, read off the subagent rows. Four render shapes carry it
 *  (all receipted): the live call row `Task: … ▸ <model> ▸ spawn_subagent`
 *  (dispatch, expanded trace), `Task(…)` live rows, per-child trace/settled
 *  rows `[N] <model> ⏱ …` / `[N] ✓ done <model> · …` (parallel batch), and
 *  viewer rows `bg ● <actor> <model> · …`. "glm-5.3" is a SUBSTRING of
 *  "glm-5.3-flash", so flash is excluded BY NAME; the parent's own status bar
 *  (`(zai) glm-5.3 • medium`) is excluded structurally — a child row must
 *  START with one of the row markers. This is the receipt's proof that the
 *  hard-problem (zai/glm-5.3) binding actually routed. */
function childModelIsGlm53(): boolean {
  const row = screen().find((l) => {
    const t = l.trimStart();
    if (!/^(Task\(|Task:|\[\d+\]|bg\b|▶)/.test(t)) return false;
    return /glm-5\.3/.test(t) && !t.includes("flash");
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
    const running = /Working\.\.\.|esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s);
    if (running) {
      sawLive = true;
      if (/· ctrl\+o to expand/.test(s)) sawHint = true;
      if (childModelIsGlm53()) receipt.checks.childModelIsGlm53 = true;
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
    const running = /Working\.\.\.|esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s);
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
    /✓ done|✗ failed|⏱ timedout|⛔ budget|⏹ turns|⊘ aborted/.test(settledScreen) ||
    // t03 vocabulary: human duration + separator'd tokens on the batch header
    /subagents batch \([^)]*\) — [0-9]+s(?! elapsed)/.test(settledScreen);
}

// ── scenario: viewer (loop hardening — background run + follow drill-down) ──
// Dispatches a BACKGROUND subagent whose task runs LONG (sleep 120 — the
// predecessor's short task always settled before the abort could fire, so the
// abort check stayed best-effort), then operates the /subagents viewer like a
// human: open → enter the Running row → follow view with a live trace →
// abort via x/y → the run must LEAVE Running (aborted badge), closing the
// best-effort gap.
async function scenarioViewer(): Promise<void> {
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
  // viewer. So: clear any filter, walk up to the `bg ●` live row, then x/y.
  tty.write("\x1b"); // follow → list
  await sleep(400);
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
    receipt.checks.abortFlow = /Abort this subagent\? y\/N/.test(readSnapText("abort-confirm") ?? "");
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
      if (/status: aborted|Subagent aborted by user/.test(s)) abortConfirmed = true;
    }
    receipt.checks.abortConfirmed = abortConfirmed;
  }
  tty.write("\x1b");
  await sleep(400);
  snap("viewer-closed", true);
}

// ── scenario: agents (agents-manager t03 — drive the /agents manager) ────────
// Pure-local drill (no LLM round-trip): open /agents over the seeded probe
// definition, read its detail, CREATE a second definition through the form,
// EDIT it (ctrl+u clears the description), then DELETE it with the y/N
// confirm. Also the live shadow check: a host builtin claiming /agents would
// make dialogOpened render something that is NOT this dialog.
async function scenarioAgents(): Promise<void> {
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
  receipt.checks.dialogOpened = /Agent types/.test(list);
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
  receipt.checks.deleteConfirm = /y confirm delete/.test(screen().join("\n"));
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
  // boot) — wait for a non-empty screen instead of checking once.
  for (let i = 0; i < 12 && screen().length === 0; i++) await sleep(1000);
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
      const running = /Working\.\.\.|esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(s);
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
  dispatch: ["booted", "liveRow", "settledBadge", "viewerOpened", "childModelIsGlm53"],
  parallel: ["booted", "liveRow", "twoRunning", "settledBadge", "childModelIsGlm53"],
  viewer: [
    "booted",
    "backgroundRow",
    "viewerOpened",
    "followTrace",
    "childModelIsGlm53",
    "abortFlow",
    "abortConfirmed",
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
