/**
 * Global detach dispatch (Task 06, cc-subagent-tui) — alt+s GLOBAL, ctrl+b
 * IN-VIEWER.
 *
 * Both detach surfaces — the GLOBAL shortcut (alt+s, registered in
 * `extensions/subagent.ts` via `pi.registerShortcut`) and the IN-VIEWER key
 * (ctrl+b, handled in `subagent-viewer.ts` on the focused row) — route through
 * the SAME detach lever: `convertToBackground` fed by `makeProdDetachDeps`
 * (Task 05). This module owns the pure dispatch LOGIC so it is testable
 * table-driven with no real terminal:
 *
 *  - global alt+s → `dispatchCtrlB` detaches the OLDEST live foreground run
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
 * WHY alt+s AND NOT ctrl+b / ctrl+shift+b
 *   (a) ctrl+b (the original chord) collides with pi's built-in default
 *       `tui.editor.cursorLeft`, so pi warned on EVERY startup ("Extension
 *       shortcut conflict: 'ctrl+b' …") and the main editor lost ctrl+b
 *       cursor-left.
 *   (b) #1481 rebound it to ctrl+shift+b to silence that warning; #1492
 *       reverted because pi-tui matches `ctrl+shift+<letter>` ONLY via the
 *       Kitty keyboard protocol (CSI-u) or xterm/tmux modifyOtherKeys — no
 *       legacy fallback — so the chord was silently dead on terminals that
 *       negotiate neither (macOS Terminal.app).
 *   (c) alt+<letter> HAS the legacy fallback: pi-tui parses the ESC-prefix
 *       form (ESC+s → "alt+s"; pi-tui dist/keys.js ESC-prefix branch) when
 *       the Kitty protocol is inactive, so the chord is deliverable on every
 *       terminal.
 *   (d) REQUIREMENT: the terminal must send ESC+s for Option+S — iTerm2:
 *       Profiles → Keys → Option key = "Esc+"; Terminal.app: "Use Option as
 *       Esc+". Ghostty and kitty pass alt+s through by default.
 *   (e) The IN-VIEWER surface keeps ctrl+b (raw \x02 byte sniff in
 *       subagent-viewer.ts, unregistered) — it only acts while the
 *       /subagents viewer owns the input, so it cannot collide with pi's
 *       keybinding layer.
 *
 * alt+s matches NO pi built-in default (no tui.* or app.* binding uses it),
 * so it claims cleanly: no startup warning, shadows nothing. See
 * ADR-subagent-0004; the repo-wide guard test in
 * pi-agent/src/__tests__/extension-shortcut-guard.test.ts keeps it that way.
 */
export const GLOBAL_DETACH_KEY = "alt+s";

/**
 * The legacy-terminal wire form of {@link GLOBAL_DETACH_KEY}: ESC followed
 * by `s`. A terminal without the Kitty keyboard protocol sends exactly this
 * for Option+S (with "Option as Esc+" / "Esc+" enabled), and pi-tui parses
 * it back to KeyId "alt+s" — which detach-key-deliverable.test.ts pins via
 * `matchesKey(GLOBAL_DETACH_SEQUENCE, GLOBAL_DETACH_KEY)`.
 */
export const GLOBAL_DETACH_SEQUENCE = "\x1bs";

/**
 * The raw control byte for ctrl+b — the IN-VIEWER-ONLY chord byte. The
 * `/subagents` viewer (`subagent-viewer.ts`) sniffs this byte directly
 * instead of going through pi's keybinding layer (the registration lives
 * nowhere, so no conflict is possible); detach-key-deliverable.test.ts pins
 * that it parses back to "ctrl+b", DISTINCT from the global chord.
 */
export const DETACH_KEY_BYTE = "\x02";

/**
 * Ids of LIVE foreground runs, oldest `startedAt` first — the global
 * detach's default target order. Terminal entries (a completed batch child
 * lingering in the registry for its k/N header, an aborted run) are
 * excluded: they are not detachable, so they must never steal the claim.
 */
export function foregroundRunIds(registry: SubagentInFlightRegistry): string[] {
  return registry
    .views({ foreground: true })
    .filter((v) => !isTerminalStatus(v.status))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((v) => v.id);
}

/**
 * Global detach dispatch (bound to alt+s; name kept from the original
 * ctrl+b binding): detach the OLDEST live foreground run. Returns the
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
