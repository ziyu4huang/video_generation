/**
 * report-tool.test.ts — the in-process report producer (webui-v3 follow-up).
 * Validation is SHARED with POST /api/report via buildReportFrame, so these
 * pin the tool-side envelope + producer contract (sink gets the frame; errors
 * are RESULTs, never throws).
 */
import { describe, expect, test } from "bun:test";
import { buildReportFrame } from "../src/report-frame.js";
import { createWebuiReportTool } from "../src/report-tool.js";

function recordSink() {
  const frames: any[] = [];
  return { frames, onReport: (f: any) => frames.push(f) };
}
async function runTool(sink: ReturnType<typeof recordSink>, params: any) {
  const tool = createWebuiReportTool({ onReport: sink.onReport }) as any;
  return tool.execute("c1", params, undefined, undefined, undefined);
}

describe("webui_report tool (in-process producer)", () => {
  test("markdown happy path: sink receives a valid frame, ok envelope", async () => {
    const sink = recordSink();
    const res = await runTool(sink, { title: "Demo", markdown: "# hi" });
    expect(sink.frames.length).toBe(1);
    const f = sink.frames[0];
    expect(f.type).toBe("report");
    expect(f.title).toBe("Demo");
    expect(f.markdown).toBe("# hi");
    expect("html" in f).toBe(false);
    expect(String(f.id).startsWith("report-")).toBe(true);
    expect(res.details.ok).toBe(true);
    expect(res.details.id).toBe(f.id);
  });

  test("html mode + agent source default + custom source honored", async () => {
    const sink = recordSink();
    await runTool(sink, { title: "G", html: "<b>x</b>" });
    expect(sink.frames[0].html).toBe("<b>x</b>");
    expect("markdown" in sink.frames[0]).toBe(false);
    expect(sink.frames[0].source).toBe("agent");
    const sink2 = recordSink();
    await runTool(sink2, { title: "G", html: "y", source: "iconify-demo" });
    expect(sink2.frames[0].source).toBe("iconify-demo");
  });

  test("dual body -> error RESULT, sink NOT called, no throw", async () => {
    const sink = recordSink();
    const res = await runTool(sink, { title: "D", markdown: "a", html: "b" });
    expect(sink.frames.length).toBe(0);
    expect(res.details.error).toBe("bad request");
  });

  test("empty title and >200 title rejected", async () => {
    const s1 = recordSink();
    const r1 = await runTool(s1, { title: "   ", markdown: "a" });
    expect(r1.details.error).toBe("bad request");
    const s2 = recordSink();
    const r2 = await runTool(s2, { title: "x".repeat(201), markdown: "a" });
    expect(r2.details.error).toBe("bad request");
    expect(s1.frames.length + s2.frames.length).toBe(0);
  });

  test("oversize body (>131072) -> payload too large", async () => {
    const sink = recordSink();
    const res = await runTool(sink, { title: "Big", html: "x".repeat(131073) });
    expect(res.details.error).toBe("payload too large");
    expect(sink.frames.length).toBe(0);
  });
});

describe("buildReportFrame — shared with POST /api/report", () => {
  test("route default source 'api'; source truncated at 100; neither body -> reject", () => {
    const r = buildReportFrame({ title: "T", markdown: "m" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frame.source).toBe("api");
    const t = buildReportFrame({ title: "T", markdown: "m", source: "s".repeat(150) });
    if (t.ok) expect(t.frame.source.length).toBe(100);
    const n = buildReportFrame({ title: "T" });
    expect(n.ok).toBe(false);
  });
});
