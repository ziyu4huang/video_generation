import { describe, expect, it, mock } from "bun:test";
import { buildPriorPrompt, describeFigureWithPrior } from "../src/vlm/figure-annotate.ts";

describe("buildPriorPrompt", () => {
  it("embeds the prior text and asks only for figures + named equation", () => {
    const p = buildPriorPrompt("Attention(Q, K, V) = softmax(QKT/√dk) V", 4);
    expect(p).toContain("PRIOR");
    expect(p).toContain("Attention(Q, K, V)");
    expect(p).toMatch(/figure/i);
    expect(p).toMatch(/latex/i);
  });

  it("includes page number in PRIOR section", () => {
    const p = buildPriorPrompt("Some text", 7);
    expect(p).toContain("page 7");
  });

  it("asks for figure description and equation rendering", () => {
    const p = buildPriorPrompt("Text", 1);
    expect(p).toContain("FIGURE description");
    expect(p).toContain("EQUATION");
  });
});

describe("describeFigureWithPrior", () => {
  it("calls askImage with the prior prompt + figure-annotator system prompt", async () => {
    const askMock = mock(() => Promise.resolve({ ok: true, reply: "Figure 2: ..." }));
    mock.module("../src/vlm/ask.ts", () => ({ askImage: askMock }));

    const r = await describeFigureWithPrior({} as any, {
      imageAbs: "/p/x.png",
      priorText: "body",
      pageNo: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.markdown).toBe("Figure 2: ...");
    expect(askMock).toHaveBeenCalled();
    const q = askMock.mock.calls[0][1] as string;
    expect(q).toContain("body");
  });

  it("passes mimeType to askImage when provided", async () => {
    const askMock = mock(() => Promise.resolve({ ok: true, reply: "Result" }));
    mock.module("../src/vlm/ask.ts", () => ({ askImage: askMock }));

    await describeFigureWithPrior({} as any, {
      imageAbs: "/p/x.jpg",
      priorText: "text",
      pageNo: 1,
      mimeType: "image/jpeg",
    });

    const opts = askMock.mock.calls[0][2] as { mimeType?: string };
    expect(opts.mimeType).toBe("image/jpeg");
  });

  it("returns error when askImage fails", async () => {
    const askMock = mock(() => Promise.resolve({ ok: false, reply: "", error: "VLM error" }));
    mock.module("../src/vlm/ask.ts", () => ({ askImage: askMock }));

    const r = await describeFigureWithPrior({} as any, {
      imageAbs: "/p/x.png",
      priorText: "text",
      pageNo: 1,
    });

    expect(r.ok).toBe(false);
    expect(r.markdown).toBe("");
    expect(r.error).toBe("VLM error");
  });
});
