/**
 * Watchdog wiring for the `subagent` tool (src/subagent-tool.ts).
 *
 * Pins the two-layer-review opt-in contract:
 *   1. watchdog OFF (default) ⇒ the result text carries NO `watchdog:` line and
 *      `details.watchdog` is undefined (no baseline capture, no runWatchdog).
 *   2. watchdog ON ⇒ the result text carries a `watchdog:` summary line AND
 *      `details.watchdog` is populated.
 *
 * The spawn seam and execute-invocation mirror regression-subagent-contract.test.ts
 * verbatim (same 5-arg execute signature: toolCallId, params, signal, onUpdate, ctx).
 *
 * Because the injected mock spawn performs NO real work, the repo baseline captured
 * pre-spawn equals the post-spawn compute — runWatchdog's edit-gate branch fires
 * (`ran:false, editGated:true, summary:"watchdog: no changes (edit-gated)"`). That
 * edit-gated summary still carries the `watchdog:` token AND is surfaced via the
 * `ran || editGated` append rule, so it satisfies the "summary line present"
 * contract without needing a real diff or an LSP server.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "@repo/pi-agent-core-runtime";
import { createSubagentTool } from "../src/subagent-tool.js";
import { ok } from "./_spawn-result.js";

// Mirrors regression-subagent-contract.test.ts — the execute() harness signature.
const NO_SIGNAL = undefined as never;
const NO_CTX = { cwd: "/repo" } as never;

/** Clean success result a no-op mock spawn returns. */
function cleanResult(): SpawnSubagentResult {
  return ok("done");
}

describe("subagent tool watchdog wiring", () => {
  test("watchdog OFF by default — no summary line, no details.watchdog", async () => {
    const tool = createSubagentTool({
      cwd: process.cwd(),
      spawn: async (_opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => cleanResult(),
    });

    const res = await tool.execute("call-1", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
    const text = (res.content[0] as { text: string }).text;

    assert.doesNotMatch(text, /watchdog:/, "watchdog is opt-in: no summary line when the param is absent");
    assert.equal(res.details.watchdog, undefined, "details.watchdog unset when watchdog is off");
  });

  test("watchdog:true appends a summary line and sets details.watchdog", async () => {
    const tool = createSubagentTool({
      cwd: process.cwd(),
      spawn: async (_opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> => cleanResult(),
    });

    const res = await tool.execute("call-2", { task: "t", watchdog: true }, NO_SIGNAL, undefined, NO_CTX);
    const text = (res.content[0] as { text: string }).text;

    assert.match(text, /watchdog:/, "watchdog:true surfaces a summary line in the result text");
    assert.ok(res.details.watchdog, "details.watchdog is populated when watchdog is on");
    assert.equal(res.details.watchdog?.editGated, true, "no-op spawn ⇒ edit-gated branch (no real diff)");
  });
});
