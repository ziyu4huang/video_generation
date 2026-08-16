/**
 * Global detach dispatch (Task 06, cc-subagent-tui) — ctrl+b on BOTH surfaces.
 *
 * Both detach surfaces — the GLOBAL shortcut (registered in
 * `extensions/subagent.ts` via `pi.registerShortcut`) and the IN-VIEWER key
 * (handled in `subagent-viewer.ts` on the focused row) — route through the
 * SAME detach lever: `convertToBackground` fed by `makeProdDetachDeps`
 * (Task 05). This module owns the pure dispatch LOGIC so it is testable
 * table-driven with no real terminal:
 *
 *  - global ctrl+b → `dispatchCtrlB` detaches the OLDEST live foreground run
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
 * The GLOBAL detach chord, as a pi `KeyId`. Registered by
 * `extensions/subagent.ts`; asserted deliverable by detach-key-deliverable.test.ts.
 *
 * WHY ctrl+b AND NOT ctrl+shift+b
 *   pi-tui matches `ctrl+shift+<letter>` ONLY via the Kitty keyboard protocol
 *   (CSI-u) or xterm/tmux modifyOtherKeys — its `shift+ctrl` branch in keys.ts
 *   has no legacy fallback, unlike the plain `ctrl` branch which accepts the
 *   raw control character. A terminal that negotiates neither (macOS
 *   Terminal.app is the common case) can only ever emit {@link DETACH_KEY_BYTE}
 *   for that chord, which parses as `ctrl+b` — so a `ctrl+shift+b` registration
 *   is UNREACHABLE there and the global detach silently does nothing.
 *
 * COST, ACCEPTED DELIBERATELY
 *   ctrl+b is pi's default `tui.editor.cursorLeft` binding, so pi emits ONE
 *   startup conflict diagnostic. That action is not in
 *   RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS, so `restrictOverride` is
 *   false and the extension shortcut WINS (extensions/runner.ts: warn, then
 *   "Using <extension>"); editor cursor-left keeps its plain `left` binding.
 *   A visible warning is the correct trade against a silently dead feature.
 */
export const GLOBAL_DETACH_KEY = "ctrl+b";

/**
 * The raw control byte a legacy terminal sends for {@link GLOBAL_DETACH_KEY}.
 * The IN-VIEWER surface (`subagent-viewer.ts`) sniffs this byte directly rather
 * than going through pi's keybinding layer, so the two surfaces stay one chord
 * only as long as this pair agrees — which detach-key-deliverable.test.ts asserts via
 * `matchesKey(DETACH_KEY_BYTE, GLOBAL_DETACH_KEY)`.
 */
export const DETACH_KEY_BYTE = "\x02";

/**
 * Ids of LIVE foreground runs, oldest `startedAt` first — the ctrl+b default
 * target order. Terminal entries (a completed batch child lingering in the
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
 * Global ctrl+b dispatch: detach the OLDEST live foreground run. Returns the
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
