// bun-apps/s2-agent-ext-btw/__tests__/webui-channel-parity.test.ts
//
// F1 originally pinned a two-sided contract: webui redeclared btw's channel
// constants locally (no package dependency webui -> btw), and this file imported
// BOTH declarations and asserted the strings matched, so a rename on either side
// failed loudly instead of silently breaking the bus seam.
//
// THE WEBUI SIDE IS GONE. PR #1532 ("webui v2 cards-first") removed the btw
// sidebar and with it `s2-agent-ext-webui/src/btw-channels.ts`, but left this
// file importing it — so the import threw, this suite errored, and main went red
// on s2-agent-ext-btw. There is no longer a second declaration to compare
// against, so the two parity assertions are deleted rather than pointed at a
// stand-in that would assert nothing.
//
// NOTE FOR WHOEVER PICKS UP THE SEAM: btw still publishes on
// `webui:btw-command` / `btw:event` (src/btw/webui-events.ts, session.ts,
// index.ts) and nothing in webui subscribes any more. That is a live publisher
// with no listener, not a bug this test can express — flagged here because
// deleting the assertions is what makes it invisible otherwise.
//
// What survives is the half that never depended on webui's copy: the seam must
// stay string-pinned, i.e. no webui source may import the btw package directly.
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { BTW_COMMAND_CHANNEL, BTW_EVENT_CHANNEL } from "../src/btw/webui-events.ts";

describe("btw/webui channel seam", () => {
  it("btw's channel names are the documented literals", () => {
    // Kept from the original parity pair: these two strings ARE the contract, so
    // a rename on the btw side still has to be a deliberate edit here.
    expect(BTW_COMMAND_CHANNEL).toBe("webui:btw-command");
    expect(BTW_EVENT_CHANNEL).toBe("btw:event");
  });

  it("no webui source file imports the btw package (seam stays string-pinned)", async () => {
    const glob = new Glob("**/*.ts");
    const files: string[] = [];
    const dir = new URL("../../s2-agent-ext-webui/src/", import.meta.url);
    for await (const path of glob.scan({ cwd: dir.pathname, onlyFiles: true })) {
      if (path.endsWith(".ts")) files.push(path);
    }
    expect(files.length).toBeGreaterThan(0); // sanity: the scan found sources
    for (const file of files) {
      const source = await Bun.file(`${dir.pathname}${file}`).text();
      expect(source.includes("@repo/s2-agent-ext-btw")).toBe(false);
    }
  });
});
