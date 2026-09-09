/**
 * tui-drive-vocab — the pinning test for scripts/lib/tui-drive-lib.ts
 * (self-arc-19 t01). Three guards:
 *
 *  a. every UI_VOCAB regex matches at least one RECORDED real sample line
 *     (shapes lifted from arc-12/14 receipt snaps) and rejects its classic
 *     negative, so a vocabulary change in pi-tui breaks HERE, in `bun test`,
 *     before any paid deployed run;
 *  b. no vocabulary pattern is re-scattered into the driver — each regex
 *     source appears ZERO times in scripts/tui-drive.ts (all judge sites go
 *     through the table) and exactly ONCE as a definition in the lib;
 *  c. the wrap-tolerant live-call-line judge latches the REAL wrapped shape
 *     (receipted: output/self-arc14-deployed-dispatch-20260908 snap-10, where
 *     the single-line judge false-FAILED) and still excludes flash by name.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  awaitBootRendered,
  callLineModelIsGlm53,
  lineHasGlm53NonFlash,
  UI_VOCAB as V,
} from "../scripts/lib/tui-drive-lib.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");

describe("UI_VOCAB sample lines (recorded render shapes)", () => {
  test("liveMarker matches spinner + working + interrupt hint; not settled text", () => {
    expect(V.liveMarker.test(" ⠹ Working… (1 tool call)")).toBe(true);
    expect(V.liveMarker.test("  esc to interrupt · ctrl+o to expand")).toBe(true);
    expect(V.liveMarker.test("✓ done · glm-5.3 · 34,283 tokens")).toBe(false);
  });
  test("expandHint matches the collapsed-row meta suffix", () => {
    expect(V.expandHint.test("↳ 8.1s elapsed · 2 tool calls · ctrl+o to expand")).toBe(true);
  });
  test("settledBadge + badgeSummary match the CC-order settled row", () => {
    expect(V.settledBadge.test("↳ ✓ done · 34,283 tokens · 2m 13s")).toBe(true);
    expect(V.settledBadge.test("⏱ timedout · glm-5.3-flash")).toBe(true);
    expect(V.badgeSummary.test("↳ report written · 34,283 tokens · 2m 13s")).toBe(true);
    expect(V.badgeSummary.test("↳ 13.4s elapsed · 3 tool calls")).toBe(false);
  });
  test("background rows: ⌛ immediate, viewer live row multi-space, log line single-space", () => {
    expect(V.backgroundRow.test("⌛ running — inspect via /subagents")).toBe(true);
    expect(V.bgLiveRow.test("▶ bg      ● hard-problem · glm-5.3 · 41s")).toBe(true);
    expect(V.bgLiveRow.test("bg ● run abc finished")).toBe(false);
    expect(V.bgLooseRow.test("bg ● run abc finished")).toBe(true);
  });
  test("abort confirms: single-run and batch shapes", () => {
    expect(V.abortConfirm.test("Abort this subagent? y/N")).toBe(true);
    expect(V.abortAllConfirm.test("Abort all 3 running children? y/N")).toBe(true);
    expect(V.abortAllConfirm.test("Abort this subagent? y/N")).toBe(false);
  });
  test("abort terminal evidence: notification or status line", () => {
    expect(V.abortConfirmedText.test("<task-notification> status: aborted")).toBe(true);
    expect(V.abortConfirmedText.test("Subagent aborted by user — run r7")).toBe(true);
    expect(V.abortConfirmedText.test("status: done")).toBe(false);
  });
  test("batchSettled: CC vocab passes; the legacy tok vocab stays negative", () => {
    expect(V.batchSettled.test("subagents batch (t1, t2) — 12s · 38,211 tokens")).toBe(true);
    expect(V.batchSettled.test("subagents batch (t1, t2) — 45.3s · 38211 tok")).toBe(false);
  });
  test("viewer + agents dialog headers", () => {
    expect(V.viewerHeader.test("Subagent runs — 1 running, 2 done")).toBe(true);
    expect(V.agentsDialogHeader.test("Agent types ↑↓ select · enter detail")).toBe(true);
    expect(V.deleteConfirm.test("d delete · y confirm delete")).toBe(true);
  });
  test("workflow rows: counter, glyph, paused glyph", () => {
    expect(V.wfAgentsCounter.test("◆ wf_receipt  1/2 agents · Work")).toBe(true);
    expect(V.wfGlyph.test("◆ wf_pause  0/2 agents")).toBe(true);
    expect(V.pausedGlyph.test("‖ wf_pause · paused")).toBe(true);
  });
  test("taskSettled: notification or terminal status", () => {
    expect(V.taskSettled.test("<task-notification> run r1 finished")).toBe(true);
    expect(V.taskSettled.test("status: done · glm-5.3")).toBe(true);
    expect(V.taskSettled.test("status: aborted")).toBe(true);
    expect(V.taskSettled.test("still running…")).toBe(false);
  });
});

describe("vocabulary is table-homed (no re-scattering)", () => {
  const driver = readFileSync(join(SCRIPTS, "tui-drive.ts"), "utf8");
  const lib = readFileSync(join(SCRIPTS, "lib", "tui-drive-lib.ts"), "utf8");

  // Bun's RegExp.source serializes non-ASCII (braille spinners, glyphs) as
  // \uXXXX escapes — decode back to literals before splitting on file text.
  const literalSource = (re: RegExp): string =>
    re.source.replace(/\\u\{?([0-9a-fA-F]{4,6})\}?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));

  test("each vocab regex appears as a definition exactly once in the lib", () => {
    for (const [name, re] of Object.entries(V)) {
      const count = lib.split(literalSource(re)).length - 1;
      expect(count, `${name} source should be defined once`).toBe(1);
    }
  });

  test("no vocab regex source remains inline in the driver", () => {
    for (const [name, re] of Object.entries(V)) {
      const count = driver.split(literalSource(re)).length - 1;
      expect(count, `${name} must be referenced via UI_VOCAB, not re-inlined`).toBe(0);
    }
  });
});

describe("callLineModelIsGlm53 (wrap-tolerant live-call-line judge)", () => {
  test("receipted wrap shape: model segment on the PREVIOUS line", () => {
    const lines = [
      "│ Task(runner): Working directory: /private/var/folders/r0/f18dr3wn6czf35q1… ▸ glm-5.3 ▸",
      "│ spawn_subagent",
    ];
    expect(callLineModelIsGlm53(lines)).toBe(true);
  });

  test("single-line call row still latches", () => {
    expect(callLineModelIsGlm53(["Task(x): draft ▸ glm-5.3 ▸ spawn_subagent"])).toBe(true);
  });

  test("flash is excluded BY NAME even across a wrap", () => {
    expect(callLineModelIsGlm53(["Task(x): draft ▸ glm-5.3-flash ▸", "spawn_subagent"])).toBe(false);
  });

  test("no spawn_subagent anchor → never matches (transcript prose cannot fake it)", () => {
    expect(callLineModelIsGlm53(["the parent should call glm-5.3 via the tool"])).toBe(false);
    expect(callLineModelIsGlm53([])).toBe(false);
  });

  test("lineHasGlm53NonFlash: glm-5.3 yes, glm-5.3-flash no", () => {
    expect(lineHasGlm53NonFlash("▸ glm-5.3 ▸")).toBe(true);
    expect(lineHasGlm53NonFlash("▸ glm-5.3-flash ▸")).toBe(false);
    expect(lineHasGlm53NonFlash("(zai) glm-5.3 • medium")).toBe(true);
  });
});

describe("awaitBootRendered (rendered-truth boot gate)", () => {
  test("resolves as soon as the screen renders non-empty", async () => {
    let calls = 0;
    let lines: string[] = [];
    const ok = await awaitBootRendered(
      () => lines,
      5_000,
      async () => {
        calls += 1;
        if (calls >= 2) lines = ["boot render"];
      },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("returns false on timeout when the screen never renders", async () => {
    const ok = await awaitBootRendered(
      () => [],
      50,
      (ms) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 40))),
    );
    expect(ok).toBe(false);
  });
});
