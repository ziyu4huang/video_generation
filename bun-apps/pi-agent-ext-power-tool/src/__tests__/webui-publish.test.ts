/**
 * webui-publish.test.ts — the dogfood door (publishAuditReport): the audit
 * tool POSTs its own report into the audited webui. Contract: never throws;
 * ok on 200, rejected on non-200, unreachable when the fetch fails.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { publishAuditReport } from "../tools/webui-tool.js";

const received: Array<{ title?: unknown; source?: unknown; markdown?: unknown }> = [];
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/api/report") {
      received.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: "report-stub" }));
      return;
    }
    res.writeHead(404).end();
  });
});
srv.listen(0);
afterAll(() => srv.close());

describe("publishAuditReport (dogfood door)", () => {
  test("200 -> ok; the frame carries the audit title/source/markdown", async () => {
    const port = (srv.address() as AddressInfo).port;
    expect(await publishAuditReport(port, "# audit md")).toBe("ok");
    expect(received.length).toBe(1);
    expect(received[0].source).toBe("webui-audit");
    expect(String(received[0].title).startsWith("webui audit — localhost:")).toBe(true);
    expect(received[0].markdown).toBe("# audit md");
  });

  test("closed port -> unreachable, never throws", async () => {
    const dead = ((srv.address() as AddressInfo).port ?? 2000) + 9; // almost surely closed
    expect(await publishAuditReport(dead, "x")).toBe("unreachable");
  });
});
