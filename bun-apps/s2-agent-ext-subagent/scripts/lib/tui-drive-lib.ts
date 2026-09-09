/**
 * tui-drive-lib — the pure, importable half of scripts/tui-drive.ts
 * (self-arc-19 t01). tui-drive.ts is a run-on-import driver (it spawns a real
 * TUI), so anything a unit test must touch lives here, in the sanctioned
 * library home (scripts-dir-contract exempts scripts/lib/**):
 *
 *   - UI_VOCAB: ONE home for every rendered-text regex the scenarios judge.
 *     Before this table the patterns were scattered literals across 10
 *     scenarios — one pi-tui wording change failed every LLM scenario at
 *     once, discovered only after a paid run. Same patterns, one home; the
 *     pinning test (tests/tui-drive-vocab.test.ts) fails if a pattern is
 *     re-scattered into the driver or a sample line stops matching.
 *   - callLineModelIsGlm53: the wrap-tolerant live-call-line judge. At
 *     COLS=100 the live call row WRAPS — `▸ glm-5.3 ▸` and the trailing
 *     `spawn_subagent` segment land on adjacent lines (receipted:
 *     output/self-arc14-deployed-dispatch-20260908 snap-10) — so the judge
 *     tests the joined neighbor pairs, not the single line.
 *   - awaitBootRendered: the rendered-truth boot gate. A freshly-mounted
 *     deployed host can sit silent mid-load; waitIdle alone returns early
 *     and the first Enter is eaten (receipted: self-arc12 deployed
 *     cc-parity r1 `booted:false`). Poll until the screen renders, THEN the
 *     caller's waitIdle runs as before.
 */

export interface UiVocab {
  /** Live-run markers ONLY — spinner frames, the working indicator, the
   *  interrupt hint. Transcript text persists after settle, so settle checks
   *  must never match this. */
  liveMarker: RegExp;
  /** Per-row hint on the collapsed live trace. */
  expandHint: RegExp;
  /** Settled child badge vocabulary (CC order). */
  settledBadge: RegExp;
  /** Settled summary line `↳ … · 34,283 tokens · …`. */
  badgeSummary: RegExp;
  /** Background dispatch's immediate pending row (the hourglass glyph). */
  backgroundRow: RegExp;
  /** The viewer's LIVE running row marker (`bg      ●`, multi-space). */
  bgLiveRow: RegExp;
  /** The viewer's bottom log line (single space before the dot — NOT the
   *  live row). */
  bgLooseRow: RegExp;
  /** Viewer abort confirm dialog (single run). */
  abortConfirm: RegExp;
  /** Viewer abort confirm dialog (batch — all running children). */
  abortAllConfirm: RegExp;
  /** Definitive abort evidence in the transcript (the notification). */
  abortConfirmedText: RegExp;
  /** Settled batch header in CC vocabulary (`… — 12s · tokens`), negative-
   *  lookahead so the OLD `45.3s · 38211 tok` vocab cannot satisfy it. */
  batchSettled: RegExp;
  /** /subagents viewer header. */
  viewerHeader: RegExp;
  /** Terminal child transition (notification or status line). */
  taskSettled: RegExp;
  /** Workflow panel counter (`k/2 agents`). */
  wfAgentsCounter: RegExp;
  /** Workflow panel row glyph. */
  wfGlyph: RegExp;
  /** Paused-workflow row glyph (structural — prose naming "paused" cannot
   *  fake it). */
  pausedGlyph: RegExp;
  /** /agents manager dialog header. */
  agentsDialogHeader: RegExp;
  /** /agents manager delete confirm footer. */
  deleteConfirm: RegExp;
}

export const UI_VOCAB: UiVocab = {
  liveMarker: /Working\.\.\.|esc to interrupt|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  expandHint: /· ctrl\+o to expand/,
  settledBadge: /✓ done|✗ failed|⏱ timedout|⛔ budget|⏹ turns|⊘ aborted/,
  badgeSummary: /↳ .* · [0-9,]+ tokens · /,
  backgroundRow: /⌛ running/,
  bgLiveRow: /bg\s{2,}●/,
  bgLooseRow: /bg ●/,
  abortConfirm: /Abort this subagent\? y\/N/,
  abortAllConfirm: /Abort all \d+ running children\? y\/N/,
  abortConfirmedText: /status: aborted|Subagent aborted by user/,
  batchSettled: /subagents batch \([^)]*\) — [0-9]+s(?! elapsed)/,
  viewerHeader: /Subagent runs/,
  taskSettled: /<task-notification>|status: (done|aborted)/,
  wfAgentsCounter: /\d\/2 agents/,
  wfGlyph: /◆/,
  pausedGlyph: /‖/,
  agentsDialogHeader: /Agent types/,
  deleteConfirm: /y confirm delete/,
};

/** The model-segment test for one candidate line: glm-5.3 present, flash
 *  excluded BY NAME ("glm-5.3" is a substring of "glm-5.3-flash"). */
export function lineHasGlm53NonFlash(line: string): boolean {
  return /glm-5\.3/.test(line) && !line.includes("flash");
}

/**
 * Wrap-tolerant live-call-line judge (self-arc-19 t01, map D2). For every
 * line carrying the trailing `spawn_subagent` segment, the model segment is
 * tested against the joined pairs (i-1, i) and (i, i+1) — the segment and the
 * model may render on adjacent lines when the row wraps at COLS=100. The
 * anchor requirement (a spawn_subagent line must exist) is unchanged from the
 * single-line judge, so transcript prose mentioning the tool in a separate
 * sentence from the model still cannot satisfy it.
 */
export function callLineModelIsGlm53(lines: string[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("spawn_subagent")) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    const next = i + 1 < lines.length ? lines[i + 1] : "";
    if (lineHasGlm53NonFlash(prev + line) || lineHasGlm53NonFlash(line + next)) return true;
  }
  return false;
}

/**
 * Boot gate (map D4): poll until the screen renders non-empty, bounded by
 * `timeoutMs`. Returns false on timeout (the caller's boot check then fails
 * honestly). Additive by design — the caller keeps its `waitIdle` settle
 * afterwards; this only guarantees the first submit lands on a rendered TUI.
 */
export async function awaitBootRendered(
  screenLines: () => string[],
  timeoutMs = 90_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const t0 = Date.now();
  while (screenLines().length === 0) {
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(1000);
  }
  return true;
}
