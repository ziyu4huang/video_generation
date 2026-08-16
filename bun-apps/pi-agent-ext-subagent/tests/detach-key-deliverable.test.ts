/**
 * The global detach chord must be DELIVERABLE, not merely conflict-free.
 *
 * WHAT WENT WRONG WITHOUT THIS TEST
 *   The chord was rebound ctrl+b → ctrl+shift+b to silence pi's startup
 *   conflict diagnostic. pi-tui matches `ctrl+shift+<letter>` only via the
 *   Kitty keyboard protocol (CSI-u) or xterm/tmux modifyOtherKeys — its
 *   `shift+ctrl` branch has NO legacy fallback, unlike the plain `ctrl` branch
 *   which accepts the raw control character. On a terminal that negotiates
 *   neither (macOS Terminal.app), the chord became unreachable and the global
 *   detach silently did nothing. Every existing test still passed, because
 *   ctrl-b-dispatch.test.ts pins the DISPATCH LOGIC with no real terminal and
 *   never sees the registered key string at all.
 *
 * WHAT THIS PINS
 *   With the Kitty protocol INACTIVE — the state a legacy terminal leaves —
 *   the raw byte such a terminal can actually emit must still match the
 *   registered chord. That is one assertion the rebind could not have survived.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { isKittyProtocolActive, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { DETACH_KEY_BYTE, GLOBAL_DETACH_KEY } from "../src/ctrl-b.js";

describe("global detach chord", () => {
  test("is reachable on a terminal WITHOUT the Kitty keyboard protocol", () => {
    // Guard the premise: if this ever defaults to true the assertion below
    // would pass vacuously (CSI-u matching would carry it) and stop protecting
    // legacy terminals.
    assert.equal(isKittyProtocolActive(), false, "premise: probe runs in the legacy-terminal state");
    assert.equal(
      matchesKey(DETACH_KEY_BYTE, GLOBAL_DETACH_KEY),
      true,
      `${GLOBAL_DETACH_KEY} is undeliverable without the Kitty protocol — a ctrl+shift+ chord cannot be typed on macOS Terminal.app`,
    );
  });

  test("the byte the in-viewer surface sniffs parses back to the SAME chord", () => {
    // The viewer bypasses pi's keybinding layer and compares the raw byte, so
    // the two detach surfaces are one chord only while this holds.
    assert.equal(parseKey(DETACH_KEY_BYTE), GLOBAL_DETACH_KEY);
  });

  test("is a plain ctrl+<letter> chord — the only form with a legacy fallback", () => {
    assert.match(GLOBAL_DETACH_KEY, /^ctrl\+[a-z]$/);
  });
});
