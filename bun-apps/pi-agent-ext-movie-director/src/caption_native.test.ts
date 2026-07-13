import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCaptionPrompt,
  isNativeCaptionRequest,
  requestedStyles,
  runCaptionNative,
  STYLE_PROMPTS,
} from "./caption_native.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "md-caption-native-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A minimal valid 1x1 PNG (base64-decoded) — good enough since the native path
// never decodes the image, only base64-encodes the raw bytes.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function writeTinyPng(dir: string, name = "img.png"): string {
  const p = join(dir, name);
  writeFileSync(p, TINY_PNG);
  return p;
}

function fakeFetch(chatContentFor: (bodyStyleHint: string) => string): typeof fetch {
  let call = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/models/load")) {
      return new Response(JSON.stringify({ status: "loaded" }), { status: 200 });
    }
    if (url.includes("/api/v1/models")) {
      return new Response(JSON.stringify({ models: [{ key: "google/gemma-4-26b-a4b-qat", loaded_instances: [{}] }] }), { status: 200 });
    }
    if (url.includes("/chat/completions")) {
      call++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const promptText: string = body.messages?.[0]?.content?.find((c: { type: string }) => c.type === "text")?.text ?? "";
      return new Response(
        JSON.stringify({ choices: [{ message: { content: chatContentFor(promptText) } }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("STYLE_PROMPTS — the 4 ported styles", () => {
  it("carries exactly default/t2i/score/review", () => {
    expect(new Set(Object.keys(STYLE_PROMPTS))).toEqual(new Set(["default", "t2i", "score", "review"]));
  });

  it("score and review both carry the shared defect-check guardrail (anti drift)", () => {
    expect(STYLE_PROMPTS.score).toContain("PLASTICKY / WAXY / OVERSMOOTHED SKIN");
    expect(STYLE_PROMPTS.review).toContain("PLASTICKY / WAXY / OVERSMOOTHED SKIN");
  });
});

describe("requestedStyles / isNativeCaptionRequest", () => {
  it("defaults to ['t2i'] when style is omitted (mirrors caption.py's argparse default)", () => {
    expect(requestedStyles({ image: "x.png" })).toEqual(["t2i"]);
  });

  it("normalizes a single string style to an array", () => {
    expect(requestedStyles({ image: "x.png", style: "score" })).toEqual(["score"]);
  });

  it("accepts a native style array", () => {
    expect(isNativeCaptionRequest({ image: "x.png", style: ["default", "score"] })).toBe(true);
  });

  it("rejects a request naming any unported style", () => {
    expect(isNativeCaptionRequest({ image: "x.png", style: ["t2i", "photography"] })).toBe(false);
  });
});

describe("buildCaptionPrompt", () => {
  it("appends the language instruction", () => {
    const p = buildCaptionPrompt("t2i", "en");
    expect(p).toContain("Write a detailed text-to-image generation prompt");
    expect(p.endsWith("Answer in English.")).toBe(true);
  });

  it("substitutes {prompt} for the review style", () => {
    const p = buildCaptionPrompt("review", "en", { prompt: "a red fox in snow" });
    expect(p).toContain("a red fox in snow");
    expect(p).not.toContain("{prompt}");
  });

  it("throws when review is requested without a prompt", () => {
    expect(() => buildCaptionPrompt("review", "en")).toThrow(/--prompt is required/);
  });

  it("throws for a style outside the native set", () => {
    expect(() => buildCaptionPrompt("photography", "en")).toThrow(/unsupported style/);
  });
});

describe("runCaptionNative", () => {
  it("writes a caption.json matching caption.py's shape for a single style", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const fetchImpl = fakeFetch(() => "a cat sitting on a windowsill");

    const out = await runCaptionNative({ options: { image, style: "t2i" }, _fetchImpl: fetchImpl });

    expect(out.details.ok).toBe(true);
    expect(out.details.captionPath).toBe(join(dir, "img.caption.json"));
    expect(out.details.model).toBe("google/gemma-4-26b-a4b-qat");
    expect(out.details.styles).toEqual(["t2i"]);
    // readCaption's single-style branch reads the nested {model,elapsed_sec,caption}
    // entry object (see caption.ts), same as it does for a run.py-produced file —
    // parity with the existing bridge, not a native-path quirk.
    expect(out.details.text).toContain("a cat sitting on a windowsill");

    const saved = JSON.parse(readFileSync(out.details.captionPath!, "utf8"));
    expect(saved.image).toBe(image);
    expect(saved.style).toBe("t2i");
    expect(saved.updated_style).toBe("t2i");
    expect(saved.styles_run).toEqual(["t2i"]);
    expect(saved.styles.t2i.caption).toBe("a cat sitting on a windowsill");
    expect(saved.caption).toBe("a cat sitting on a windowsill");
  });

  it("strips <think> reasoning blocks from the VLM response", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const fetchImpl = fakeFetch(() => "<think>hmm let me look</think>\na quiet street at dusk");

    const out = await runCaptionNative({ options: { image, style: "default" }, _fetchImpl: fetchImpl });

    expect(out.details.text).toContain("a quiet street at dusk");
    expect(out.details.text).not.toContain("<think>");
    const saved = JSON.parse(readFileSync(out.details.captionPath!, "utf8"));
    expect(saved.caption).toBe("a quiet street at dusk");
  });

  it("merges a second style into an existing caption.json without dropping the first (mirrors test_second_style_preserves_first)", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const fetchImpl1 = fakeFetch(() => "a description of the scene");
    await runCaptionNative({ options: { image, style: "default" }, _fetchImpl: fetchImpl1 });

    const fetchImpl2 = fakeFetch(() => '{"overall": 8}');
    const out2 = await runCaptionNative({ options: { image, style: "score" }, _fetchImpl: fetchImpl2 });

    const saved = JSON.parse(readFileSync(out2.details.captionPath!, "utf8"));
    expect(Object.keys(saved.styles).sort()).toEqual(["default", "score"]);
    expect(saved.styles.default.caption).toBe("a description of the scene");
    expect(saved.styles.score.caption).toBe('{"overall": 8}');
    expect(saved.updated_style).toBe("score");
    expect(saved.style).toBe("score");
  });

  it("runs multiple styles in one call and records styles_run for just that call", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const fetchImpl = fakeFetch((promptText) => (promptText.includes("STRICT") ? '{"overall": 9}' : "a description"));

    const out = await runCaptionNative({ options: { image, style: ["default", "score"] }, _fetchImpl: fetchImpl });

    expect(out.details.ok).toBe(true);
    expect(out.details.styles.sort()).toEqual(["default", "score"]);
    const saved = JSON.parse(readFileSync(out.details.captionPath!, "utf8"));
    expect(saved.styles_run).toEqual(["default", "score"]);
  });

  it("fails cleanly when the image does not exist", async () => {
    const out = await runCaptionNative({ options: { image: "/does/not/exist.png", style: "t2i" } });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("image not found");
  });

  it("fails cleanly when review is requested without --prompt", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const out = await runCaptionNative({ options: { image, style: "review" } });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("--prompt is required");
  });

  it("fails cleanly when the VLM call throws", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/models")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (url.includes("/models/load")) return new Response("{}", { status: 200 });
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    const out = await runCaptionNative({ options: { image, style: "t2i" }, _fetchImpl: fetchImpl });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("caption_native FAILED");
  });
});
