/**
 * webui-btw-tool.test.ts — mode "btw": drain the BTW tab queue WITHOUT
 * launching a browser (pure fetch), the agent-side half of the branch loop.
 * (Moved from s2-agent-ext-power-tool with the tool itself.)
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { makeWebuiTool } from "../src/webui-tool.js";

const pending = [
  { id: "btw-1", question: "why is the scrollbar inset?", chips: ["css"], aboutTitle: "Architecture" },
  { id: "btw-2", question: "general: what next?", chips: [] },
];
const srv = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/btw") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pending }));
    return;
  }
  res.writeHead(404).end();
});
srv.listen(0);
afterAll(() => srv.close());

describe("webui tool — mode btw", () => {
  test("lists pending branch questions with context + resolve hint", async () => {
    const port = (srv.address() as { port: number }).port;
    const tool = makeWebuiTool() as unknown as {
      execute: (id: string, params: Record<string, unknown>, signal?: undefined) => Promise<{ content: Array<{ type: string; text: string }> }>;
    };
    const out = await tool.execute("t", { port, mode: "btw" }, undefined);
    const text = out.content[0]!.text;
    expect(text).toContain("2 pending branch question(s)");
    expect(text).toContain("why is the scrollbar inset?");
    expect(text).toContain("(about: Architecture)");
    expect(text).toContain("hints: css");
    expect(text).toContain("/api/btw/<id>/resolve");
  });
});
