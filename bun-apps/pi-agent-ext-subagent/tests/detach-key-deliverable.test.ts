/**
 * The global detach chord must be DELIVERABLE, not merely conflict-free.
 *
 * WHAT WENT WRONG WITHOUT THIS TEST
 *   The chord has been rebound twice. #1481 moved it ctrl+b → ctrl+shift+b
 *   to silence pi's startup conflict diagnostic — but pi-tui matches
 *   `ctrl+shift+<letter>` only via the Kitty keyboard protocol (CSI-u) or
 *   xterm/tmux modifyOtherKeys, with NO legacy fallback, so on a terminal
 *   that negotiates neither (macOS Terminal.app) the chord became
 *   unreachable and the global detach silently did nothing. Every existing
 *   test still passed, because ctrl-b-dispatch.test.ts pins the DISPATCH
 *   LOGIC with no real terminal and never sees the registered key string at
 *   all. #1492 reverted to ctrl+b and accepted the warning ("a visible
 *   warning beats a silently dead feature"). The final rebind
 *   (ADR-subagent-0004) is alt+s: pi-tui parses the legacy ESC-prefix wire
 *   form (ESC+s → "alt+s") when the Kitty protocol is inactive, so every
 *   terminal can deliver it (iTerm2: Option key = "Esc+"; Terminal.app:
 *   "Use Option as Esc+").
 *
 * WHAT THIS PINS
 *   With the Kitty protocol INACTIVE — the state a legacy terminal leaves —
 *   the ESC-prefix sequence such a terminal actually emits must still match
 *   the registered chord, the in-viewer byte must stay a DISTINCT ctrl+b,
 *   and the global chord must stay in the only modifier+letter family with
 *   a legacy fallback.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { isKittyProtocolActive, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { DETACH_KEY_BYTE, GLOBAL_DETACH_KEY, GLOBAL_DETACH_SEQUENCE } from "../src/ctrl-b.js";

describe("global detach chord", () => {
  test("is reachable on a terminal WITHOUT the Kitty keyboard protocol", () => {
    // Guard the premise: if this ever defaults to true the assertion below
    // would pass vacuously (CSI-u matching would carry it) and stop protecting
    // legacy terminals.
    assert.equal(isKittyProtocolActive(), false, "premise: probe runs in the legacy-terminal state");
    assert.equal(
      matchesKey(GLOBAL_DETACH_SEQUENCE, GLOBAL_DETACH_KEY),
      true,
      `${GLOBAL_DETACH_KEY} is undeliverable without the Kitty protocol — the legacy ESC-prefix sequence must parse to the registered chord`,
    );
  });

  test("the byte the in-viewer surface sniffs parses back to ctrl+b, DISTINCT from the global chord", () => {
    // The viewer bypasses pi's keybinding layer and compares the raw byte, so
    // the in-viewer ctrl+b stays deliverable while the GLOBAL chord is alt+s
    // (a different surface, a different key — deliberately).
    assert.equal(parseKey(DETACH_KEY_BYTE), "ctrl+b");
    assert.notEqual(parseKey(DETACH_KEY_BYTE), GLOBAL_DETACH_KEY);
  });

  test("is a plain alt+<letter> chord — the only modifier+letter form with a legacy ESC-prefix fallback", () => {
    // ctrl+<letter> also has a legacy fallback (the raw control byte) but
    // collides with pi built-ins; ctrl+shift+<letter> has none at all.
    assert.match(GLOBAL_DETACH_KEY, /^alt\+[a-z]$/);
  });
});
