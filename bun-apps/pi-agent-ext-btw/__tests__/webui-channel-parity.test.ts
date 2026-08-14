// bun-apps/pi-agent-ext-btw/__tests__/webui-channel-parity.test.ts
// F1: pin the cross-package channel-name contract. The webui package locally
// redeclares the channel constants (no package dependency webui -> btw); these
// tests import BOTH declarations and assert the string values match, so a
// rename on either side fails loudly instead of silently breaking the bus seam.
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
// Webui-side local redeclaration (intentional duplication is the contract).
import {
  BTW_COMMAND_CHANNEL as WUI_CMD,
  BTW_EVENT_CHANNEL as WUI_EVT,
} from "../../pi-agent-ext-webui/src/btw-channels.ts";
// Btw-side canonical declaration.
import { BTW_COMMAND_CHANNEL, BTW_EVENT_CHANNEL } from "../src/btw/webui-events.ts";

describe("btw/webui channel parity", () => {
  it("command channel name matches between btw and webui declarations", () => {
    expect(WUI_CMD).toBe(BTW_COMMAND_CHANNEL);
    expect(WUI_CMD).toBe("webui:btw-command");
  });

  it("event channel name matches between btw and webui declarations", () => {
    expect(WUI_EVT).toBe(BTW_EVENT_CHANNEL);
    expect(WUI_EVT).toBe("btw:event");
  });

  it("no webui source file imports the btw package (seam stays string-pinned)", async () => {
    const glob = new Glob("**/*.ts");
    const files: string[] = [];
    const dir = new URL("../../pi-agent-ext-webui/src/", import.meta.url);
    for await (const path of glob.scan({ cwd: dir.pathname, onlyFiles: true })) {
      if (path.endsWith(".ts")) files.push(path);
    }
    expect(files.length).toBeGreaterThan(0); // sanity: the scan found sources
    for (const file of files) {
      const source = await Bun.file(`${dir.pathname}${file}`).text();
      expect(source.includes("@repo/pi-agent-ext-btw")).toBe(false);
    }
  });
});
