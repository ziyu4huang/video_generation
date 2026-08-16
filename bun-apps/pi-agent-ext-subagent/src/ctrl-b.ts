/**
 * Global detach dispatch (Task 06, cc-subagent-tui) — global key is
 * ctrl+shift+b (rebound from ctrl+b, which shadowed pi's built-in
 * cursorLeft); the in-viewer key remains ctrl+b.
 *
 * Both detach surfaces — the GLOBAL shortcut (registered in
 * `extensions/subagent.ts` via `pi.registerShortcut`) and the IN-VIEWER key
 * (handled in `subagent-viewer.ts` on the focused row) — route through the
 * SAME detach lever: `convertToBackground` fed by `makeProdDetachDeps`
 * (Task 05). This module owns the pure dispatch LOGIC so it is testable
 * table-driven with no real terminal:
 *
 *  - global ctrl+shift+b → `dispatchCtrlB` detaches the OLDEST live foreground run
 *    (age = startedAt; the "first thing you launched" intuition);
 *  - no live foreground run → a silent no-op (never throws, convert never
 *    called — the key is unclaimed in the empty case);
 *  - terminal foreground entries are NOT detach targets (refusal inside
 *    `convertToBackground` is the capability's own contract; the dispatcher
 *    simply never targets them);
 *  - in-viewer ctrl+b does NOT go through `dispatchCtrlB` — the viewer's
 *    focused row IS the target, regardless of age order.
 *
 * The post-detach "detached → background" notify line needs no seam here: it
 * fires from the registry's `foreground:true → false` flip (Task 02's
 * `SubagentNotify` diff rule), covered by ext-task's notify.test.ts
 * integration test.
 */
import type { SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import { isTerminalStatus } from "@repo/pi-agent-core-runtime";
import type { DetachOutcome } from "./detach-run.js";

/**
 * Ids of LIVE foreground runs, oldest `startedAt` first — the global detach
 * default target order. Terminal entries (a completed batch child lingering in the
 * registry for its k/N header, an aborted run) are excluded: they are not
 * detachable, so they must never steal the claim.
 */
export function foregroundRunIds(registry: SubagentInFlightRegistry): string[] {
  return registry
    .views({ foreground: true })
    .filter((v) => !isTerminalStatus(v.status))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((v) => v.id);
}

/**
 * Global ctrl+shift+b dispatch: detach the OLDEST live foreground run. Returns the
 * convert outcome for the detached run, or `undefined` when there is no live
 * foreground run (no-op — never throws, `convert` is never called). The
 * `convert` seam is `(id) => DetachOutcome` so tests inject a fake; prod is
 * `(id) => convertToBackground(id, makeProdDetachDeps())`.
 */
export function dispatchCtrlB(
  registry: SubagentInFlightRegistry,
  convert: (id: string) => DetachOutcome,
): DetachOutcome | undefined {
  const [oldest] = foregroundRunIds(registry);
  if (!oldest) return undefined;
  return convert(oldest);
}
