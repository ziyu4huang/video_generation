import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCaptionPrompt,
  isNativeCaptionRequest,
  isVideoInput,
  loadAtoms,
  medianScoreCaption,
  parsePoseDsg,
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
      return new Response(JSON.stringify({ models: [{ key: "prism-ml/bonsai-27b", loaded_instances: [{}] }] }), { status: 200 });
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

const ALL_14 = [
  "default", "photography", "t2i", "profile", "style", "score", "video_score",
  "video_analysis", "compare", "review", "playwright", "lora_quality", "ltx_i2v", "pose_dsg",
];

describe("STYLE_PROMPTS — all 14 styles ported verbatim", () => {
  it("carries exactly the 14 caption.py styles", () => {
    expect(new Set(Object.keys(STYLE_PROMPTS))).toEqual(new Set(ALL_14));
  });

  it("the four defect-check styles share the guardrail (anti drift)", () => {
    for (const s of ["score", "review", "lora_quality", "pose_dsg"]) {
      expect(STYLE_PROMPTS[s]).toContain("PLASTICKY / WAXY / OVERSMOOTHED SKIN");
    }
  });
});

describe("requestedStyles / isNativeCaptionRequest", () => {
  it("defaults to ['t2i'] when style is omitted (mirrors caption.py's argparse default)", () => {
    expect(requestedStyles({ image: "x.png" })).toEqual(["t2i"]);
  });

  it("normalizes a single string style to an array", () => {
    expect(requestedStyles({ image: "x.png", style: "score" })).toEqual(["score"]);
  });

  it("accepts any of the 14 native styles", () => {
    expect(isNativeCaptionRequest({ image: "x.png", style: ["default", "photography", "pose_dsg"] })).toBe(true);
  });

  it("rejects a request naming an unknown style", () => {
    expect(isNativeCaptionRequest({ image: "x.png", style: ["t2i", "bogus"] })).toBe(false);
  });
});

describe("buildCaptionPrompt — placeholder substitution", () => {
  it("appends the language instruction", () => {
    const p = buildCaptionPrompt("t2i", "en", { image: "x.png" });
    expect(p).toContain("Write a detailed text-to-image generation prompt");
    expect(p.endsWith("Answer in English.")).toBe(true);
  });

  it("substitutes {prompt} for the review style", () => {
    const p = buildCaptionPrompt("review", "en", { image: "x.png", prompt: "a red fox in snow" });
    expect(p).toContain("a red fox in snow");
    expect(p).not.toContain("{prompt}");
  });

  it("substitutes {action} for the ltx_i2v style", () => {
    const p = buildCaptionPrompt("ltx_i2v", "en", { image: "x.png", action: "she waves and smiles" });
    expect(p).toContain("she waves and smiles");
    expect(p).not.toContain("{action}");
  });

  it("substitutes {lora_name}/{lora_description}/{scale} for the lora_quality style", () => {
    const p = buildCaptionPrompt("lora_quality", "en", {
      image: "x.png", loraName: "anime-v2", loraDescription: "anime look", loraScale: 0.8,
    });
    expect(p).toContain("LoRA: anime-v2");
    expect(p).toContain("Description: anime look");
    expect(p).toContain("Scale applied: 0.8");
  });

  it("substitutes {prompt} + {atoms_block} for pose_dsg with explicit atoms", () => {
    const atomsFile = join(tmpDir(), "atoms.json");
    writeFileSync(atomsFile, JSON.stringify({ atoms: [{ id: "a1", q: "exactly one woman" }] }));
    const p = buildCaptionPrompt("pose_dsg", "en", { image: "x.png", prompt: "a woman standing", atoms: atomsFile });
    expect(p).toContain("a woman standing");
    expect(p).toContain("Use EXACTLY these atoms");
    expect(p).toContain("- a1: exactly one woman");
    expect(p).not.toContain("{atoms_block}");
  });

  it("pose_dsg without atoms instructs self-decomposition", () => {
    const p = buildCaptionPrompt("pose_dsg", "en", { image: "x.png", prompt: "a woman standing" });
    expect(p).toContain("Derive 5-10 atoms yourself");
  });

  it("throws when review is requested without a prompt", () => {
    expect(() => buildCaptionPrompt("review", "en", { image: "x.png" })).toThrow(/--prompt is required/);
  });

  it("throws for a style outside the native set", () => {
    expect(() => buildCaptionPrompt("bogus", "en", { image: "x.png" })).toThrow(/unsupported style/);
  });
});

describe("video input detection", () => {
  it("flags video extensions and not images", () => {
    for (const ext of [".mp4", ".mov", ".avi", ".webm", ".mkv", ".gif"]) {
      expect(isVideoInput(`/x/v${ext}`)).toBe(true);
    }
    for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
      expect(isVideoInput(`/x/i${ext}`)).toBe(false);
    }
  });
});

describe("medianScoreCaption — --samples N denoising (port of median_score_caption)", () => {
  it("returns the single raw when only one parses", () => {
    expect(medianScoreCaption(['{"overall": 7}'])).toBe('{"overall":7,"scoreSamples":1}');
  });

  it("medians numeric dims and unions array dims across samples", () => {
    const raws = [
      '{"overall": 6, "detail": 5, "issues": ["hands"], "summary": "ok"}',
      '{"overall": 8, "detail": 7, "issues": ["skin"], "summary": "decent"}',
    ];
    const out = JSON.parse(medianScoreCaption(raws));
    expect(out.overall).toBe(7); // median(6,8)
    expect(out.detail).toBe(6); // median(5,7)
    expect(out.issues).toEqual(["hands", "skin"]); // order-preserving union
    expect(out.summary).toBe("ok"); // carrier = sample whose overall is closest to median (6 vs 7)
    expect(out.scoreSamples).toBe(2);
  });

  it("falls back to the first raw on total parse failure", () => {
    expect(medianScoreCaption(["not json", "also not"])).toBe("not json");
  });
});

describe("parsePoseDsg — recomputes aggregates (never trusts model arithmetic)", () => {
  it("recomputes faithfulness from atoms and anatomy_pass from anatomy fields", () => {
    const vlm = {
      atoms: [
        { id: "a1", q: "one woman", present: true, confidence: 0.9 },
        { id: "a2", q: "standing", present: false, confidence: 0.4 },
        { id: "a3", q: "smiling", present: true, confidence: 0.8 },
      ],
      faithfulness: 1.0, // model lies — must be recomputed to 2/3
      anatomy: { limb_count: true, hands: true, face: true, pose_plausible: true },
      anatomy_pass: false, // model lies — all anatomy true → must be true
      issues: ["a2 missing"],
      summary: "two of three",
    };
    const out = parsePoseDsg(JSON.stringify(vlm));
    expect(out.faithfulness).toBe(0.667);
    expect(out.anatomy_pass).toBe(true);
    expect(out.atoms).toHaveLength(3);
    expect(out.issues).toEqual(["a2 missing"]);
  });

  it("face 'n/a' never fails the gate; a visible-but-false face does", () => {
    expect(parsePoseDsg({ anatomy: { limb_count: true, hands: true, face: "n/a", pose_plausible: true }, atoms: [] }).anatomy_pass).toBe(true);
    expect(parsePoseDsg({ anatomy: { limb_count: true, hands: true, face: false, pose_plausible: true }, atoms: [] }).anatomy_pass).toBe(false);
  });
});

describe("loadAtoms", () => {
  it("accepts inline JSON and a bare list, defaulting ids", () => {
    expect(loadAtoms(JSON.stringify({ atoms: [{ id: "a1", q: "x" }] }))).toEqual([{ id: "a1", q: "x" }]);
    expect(loadAtoms(JSON.stringify([{ q: "y" }]))).toEqual([{ id: "a1", q: "y" }]);
  });

  it("returns null when no spec given (VLM self-decomposes)", () => {
    expect(loadAtoms(undefined)).toBeNull();
  });

  it("rejects an empty / malformed list", () => {
    expect(() => loadAtoms("[]")).toThrow(/non-empty/);
    expect(() => loadAtoms("[{}")).toThrow();
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
    expect(out.details.model).toBe("prism-ml/bonsai-27b");
    expect(out.details.styles).toEqual(["t2i"]);
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

  it("merges a second style into an existing caption.json without dropping the first", async () => {
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

  it("runs --samples N for a score style (median across N VLM calls)", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const seq = ['{"overall": 6, "summary": "a"}', '{"overall": 8, "summary": "b"}', '{"overall": 7, "summary": "c"}'];
    const fetchImpl = fakeFetch(() => seq.shift() ?? '{"overall": 7}');

    const out = await runCaptionNative({ options: { image, style: "score", samples: 3 }, _fetchImpl: fetchImpl });

    expect(out.details.ok).toBe(true);
    const saved = JSON.parse(readFileSync(out.details.captionPath!, "utf8"));
    expect(saved.styles.score.caption).toContain('"scoreSamples":3');
    expect(JSON.parse(saved.styles.score.caption).overall).toBe(7); // median(6,8,7)
  });

  it("recomputes pose_dsg aggregates after the VLM call", async () => {
    const dir = tmpDir();
    const image = writeTinyPng(dir);
    const fetchImpl = fakeFetch(() =>
      '{"atoms":[{"id":"a1","q":"one woman","present":true,"confidence":0.9},' +
      '{"id":"a2","q":"standing","present":false,"confidence":0.4}],' +
      '"faithfulness":1.0,"anatomy":{"limb_count":true,"hands":true,"face":true,"pose_plausible":true},' +
      '"anatomy_pass":false,"summary":"x"}',
    );

    const out = await runCaptionNative({ options: { image, style: "pose_dsg", prompt: "a woman standing" }, _fetchImpl: fetchImpl });
    expect(out.details.ok).toBe(true);
    const saved = JSON.parse(readFileSync(out.details.captionPath!, "utf8"));
    // pose_dsg caption is the recomputed dict, NOT the raw VLM string.
    expect(saved.styles.pose_dsg.caption.faithfulness).toBe(0.5);
    expect(saved.styles.pose_dsg.caption.anatomy_pass).toBe(true);
  });

  it("fails cleanly when the image does not exist", async () => {
    const out = await runCaptionNative({ options: { image: "/does/not/exist.png", style: "t2i" } });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("input not found");
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
