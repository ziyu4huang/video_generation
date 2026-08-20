import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseScoreDict,
  coerceJudgeScores,
  pickBest,
  resolveGeometry,
  composeTwoSubjectPrompt,
  judgeTwoSubject,
  captionRefImage,
  runTwosubjectNative,
  DEFAULT_CANDIDATES,
  DEFAULT_BASE_SEED,
  DEFAULT_MIN_OVERALL,
  type ScoredCandidate,
  type T2iFn,
} from "./twosubject_native.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "twosubject-native-test-"));
}

// A minimal 1x1 PNG (valid file bytes; content is irrelevant since fetch is mocked).
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);

function writeTinyPng(dir: string, name = "ref.png"): string {
  const p = join(dir, name);
  writeFileSync(p, TINY_PNG);
  return p;
}

function fakeLmStudio(contentFor: (url: string, body: string) => string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/models") && !url.includes("/load")) {
      return new Response(JSON.stringify({ models: [{ key: "google/gemma-4-12b", loaded_instances: [{}] }] }), { status: 200 });
    }
    if (url.includes("/models/load")) {
      return new Response(JSON.stringify({ status: "loaded" }), { status: 200 });
    }
    if (url.includes("/chat/completions")) {
      const body = String(init?.body ?? "");
      const content = contentFor(url, body);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("parseScoreDict — tolerant JSON-object extraction", () => {
  it("parses a bare JSON object", () => {
    expect(parseScoreDict('{"overall":8}')).toEqual({ overall: 8 });
  });

  it("strips ```json fences", () => {
    expect(parseScoreDict('```json\n{"overall":7}\n```')).toEqual({ overall: 7 });
  });

  it("finds the first { ... } amid prose", () => {
    expect(parseScoreDict('Sure:\n{"overall":9}\nDone.')).toEqual({ overall: 9 });
  });

  it("returns null on unparseable text", () => {
    expect(parseScoreDict("no json here")).toBeNull();
  });
});

describe("coerceJudgeScores", () => {
  it("coerces numeric fields and defaults missing ones", () => {
    const raw = JSON.stringify({ both_present: true, distinct: false, bleeding: ["hair"], natural: "6", overall: 7.5, summary: "ok" });
    const s = coerceJudgeScores(raw);
    expect(s).toEqual({ both_present: true, distinct: false, bleeding: ["hair"], natural: 6, overall: 7.5, summary: "ok" });
  });

  it("marks unparseable output with overall:null and unparsed:true", () => {
    const s = coerceJudgeScores("garbage, not json");
    expect(s.overall).toBeNull();
    expect(s.unparsed).toBe(true);
  });
});

describe("pickBest — overall → natural → distinct ranking", () => {
  const base: Omit<ScoredCandidate, "seed" | "path"> = { both_present: true, distinct: true, bleeding: [], natural: 5, overall: 5, summary: "" };

  it("picks the highest overall", () => {
    const cands: ScoredCandidate[] = [
      { ...base, path: "a.png", seed: 1, overall: 6 },
      { ...base, path: "b.png", seed: 2, overall: 9 },
      { ...base, path: "c.png", seed: 3, overall: 7 },
    ];
    expect(pickBest(cands)?.seed).toBe(2);
  });

  it("tie-breaks on natural when overall ties", () => {
    const cands: ScoredCandidate[] = [
      { ...base, path: "a.png", seed: 1, overall: 8, natural: 4 },
      { ...base, path: "b.png", seed: 2, overall: 8, natural: 9 },
    ];
    expect(pickBest(cands)?.seed).toBe(2);
  });

  it("tie-breaks on distinct (true>false) when overall+natural tie", () => {
    const cands: ScoredCandidate[] = [
      { ...base, path: "a.png", seed: 1, overall: 8, natural: 5, distinct: false },
      { ...base, path: "b.png", seed: 2, overall: 8, natural: 5, distinct: true },
    ];
    expect(pickBest(cands)?.seed).toBe(2);
  });

  it("excludes candidates with overall:null (unparseable judge output)", () => {
    const cands: ScoredCandidate[] = [
      { ...base, path: "a.png", seed: 1, overall: null },
      { ...base, path: "b.png", seed: 2, overall: 4 },
    ];
    expect(pickBest(cands)?.seed).toBe(2);
  });

  it("returns null when no candidate scored", () => {
    const cands: ScoredCandidate[] = [{ ...base, path: "a.png", seed: 1, overall: null }];
    expect(pickBest(cands)).toBeNull();
  });
});

describe("resolveGeometry — mirrors _resolve_geometry's --detail preset", () => {
  it("defaults to the fast preset (640x960/9)", () => {
    expect(resolveGeometry({})).toEqual({ width: 640, height: 960, steps: 9 });
  });

  it("--detail switches to the high-detail preset (768x1152/20)", () => {
    expect(resolveGeometry({ detail: true })).toEqual({ width: 768, height: 1152, steps: 20 });
  });

  it("explicit width/height/steps override the preset either way", () => {
    expect(resolveGeometry({ detail: true, width: 512, steps: 4 })).toEqual({ width: 512, height: 1152, steps: 4 });
  });
});

describe("composeTwoSubjectPrompt — VLM prompt-master (mocked fetch)", () => {
  it("returns the composed prompt text, stripped of <think> blocks", async () => {
    const fetchImpl = fakeLmStudio(() => "<think>reasoning</think>\ntwo women in a dreamlike scene, the woman on the FAR LEFT: ...");
    const p = await composeTwoSubjectPrompt("desc a", "desc b", [], null, { _fetchImpl: fetchImpl });
    expect(p).toBe("two women in a dreamlike scene, the woman on the FAR LEFT: ...");
  });

  it("includes revise instructions when a failure is passed", async () => {
    let capturedBody = "";
    const fetchImpl = fakeLmStudio((_url, body) => {
      capturedBody = body;
      return "revised prompt";
    });
    await composeTwoSubjectPrompt("desc a", "desc b", [], { bleeding: ["hair color"], summary: "hair swapped" }, { _fetchImpl: fetchImpl });
    expect(capturedBody).toContain("hair color");
    expect(capturedBody).toContain("hair swapped");
    expect(capturedBody).toContain("PREVIOUS attempt");
  });
});

describe("judgeTwoSubject — VLM judge (mocked fetch)", () => {
  it("scores a candidate image against the two-subject rubric", async () => {
    const dir = tmpDir();
    const img = writeTinyPng(dir);
    const raw = JSON.stringify({ both_present: true, distinct: true, bleeding: [], natural: 8, overall: 8.5, summary: "good" });
    const fetchImpl = fakeLmStudio(() => raw);
    const scores = await judgeTwoSubject(img, "desc a", "desc b", { _fetchImpl: fetchImpl });
    expect(scores.overall).toBe(8.5);
    expect(scores.distinct).toBe(true);
  });
});

describe("captionRefImage — i2t caption for a reference image (mocked fetch)", () => {
  it("returns the stripped caption text", async () => {
    const dir = tmpDir();
    const img = writeTinyPng(dir);
    const fetchImpl = fakeLmStudio(() => "<think>looking</think>\na young woman with dark hair");
    const desc = await captionRefImage(img, { _fetchImpl: fetchImpl });
    expect(desc).toBe("a young woman with dark hair");
  });
});

describe("runTwosubjectNative — the full loop (mocked t2i + mocked VLM)", () => {
  it("runs Phase 1-3 (compose → best-of-N → judge) and returns the best-scored winner", async () => {
    const dir = tmpDir();
    let composeCalls = 0;
    let judgeCalls = 0;
    const t2iCalls: number[] = [];

    const fetchImpl = fakeLmStudio((_url, body) => {
      // The judge prompt always contains "STRICT JSON"; the compose prompt doesn't.
      if (body.includes("STRICT JSON")) {
        judgeCalls++;
        // seed-dependent score: give a clear winner
        const overall = judgeCalls === 2 ? 9.2 : 5.0;
        return JSON.stringify({ both_present: true, distinct: true, bleeding: [], natural: overall, overall, summary: "s" });
      }
      composeCalls++;
      return "two people in one dreamlike scene, far left / far right anchored";
    });

    const t2i: T2iFn = async (params) => {
      t2iCalls.push(params.seed);
      const p = join(dir, `cand_${params.seed}.png`);
      writeFileSync(p, TINY_PNG);
      return { path: p, seed: params.seed };
    };

    const result = await runTwosubjectNative({
      candidates: 3,
      rounds: 1,
      _t2iImpl: t2i,
      _fetchImpl: fetchImpl,
      outputDir: dir,
    });

    expect(t2iCalls).toEqual([DEFAULT_BASE_SEED, DEFAULT_BASE_SEED + 1, DEFAULT_BASE_SEED + 2]);
    expect(composeCalls).toBe(1);
    expect(judgeCalls).toBe(3);
    expect(result.winnerSeed).toBe(DEFAULT_BASE_SEED + 1); // the 2nd judged candidate scored 9.2
    expect(result.winnerScores.overall).toBe(9.2);
    expect(result.roundsRun).toBe(1);
    expect(result.candidatesPerRound).toBe(3);
    expect(result.history).toHaveLength(1);
  });

  it("defaults candidates to DEFAULT_CANDIDATES (12) when omitted", async () => {
    const dir = tmpDir();
    const t2iCalls: number[] = [];
    const fetchImpl = fakeLmStudio((_url, body) => {
      if (body.includes("STRICT JSON")) {
        return JSON.stringify({ both_present: true, distinct: true, bleeding: [], natural: 7, overall: 7, summary: "s" });
      }
      return "a composed prompt";
    });
    const t2i: T2iFn = async (params) => {
      t2iCalls.push(params.seed);
      const p = join(dir, `cand_${params.seed}.png`);
      writeFileSync(p, TINY_PNG);
      return { path: p, seed: params.seed };
    };

    await runTwosubjectNative({ _t2iImpl: t2i, _fetchImpl: fetchImpl, outputDir: dir });
    expect(t2iCalls).toHaveLength(DEFAULT_CANDIDATES);
  });

  it("stops early on round 1 when best overall already clears --min-overall (no revise call)", async () => {
    const dir = tmpDir();
    let composeCalls = 0;
    const fetchImpl = fakeLmStudio((_url, body) => {
      if (body.includes("STRICT JSON")) {
        return JSON.stringify({ both_present: true, distinct: true, bleeding: [], natural: 9, overall: DEFAULT_MIN_OVERALL + 0.5, summary: "s" });
      }
      composeCalls++;
      return "a composed prompt";
    });
    const t2i: T2iFn = async (params) => {
      const p = join(dir, `cand_${params.seed}.png`);
      writeFileSync(p, TINY_PNG);
      return { path: p, seed: params.seed };
    };

    const result = await runTwosubjectNative({ candidates: 2, rounds: 3, _t2iImpl: t2i, _fetchImpl: fetchImpl, outputDir: dir });
    expect(composeCalls).toBe(1); // only round 1 ran — accepted early
    expect(result.roundsRun).toBe(1);
  });

  it("runs a revise round when round 1's best overall is below --min-overall and rounds>1", async () => {
    const dir = tmpDir();
    let composeCalls = 0;
    let capturedRevisePromptSeen = false;
    const fetchImpl = fakeLmStudio((_url, body) => {
      if (body.includes("STRICT JSON")) {
        return JSON.stringify({ both_present: true, distinct: false, bleeding: ["hair"], natural: 4, overall: 3, summary: "bleeding" });
      }
      composeCalls++;
      if (body.includes("PREVIOUS attempt")) capturedRevisePromptSeen = true;
      return "a composed prompt";
    });
    const t2i: T2iFn = async (params) => {
      const p = join(dir, `cand_${params.seed}_r${composeCalls}.png`);
      writeFileSync(p, TINY_PNG);
      return { path: p, seed: params.seed };
    };

    const result = await runTwosubjectNative({ candidates: 1, rounds: 2, _t2iImpl: t2i, _fetchImpl: fetchImpl, outputDir: dir });
    expect(composeCalls).toBe(2);
    expect(capturedRevisePromptSeen).toBe(true);
    expect(result.roundsRun).toBe(2);
  });

  it("captions reference images (Phase 0) and passes both to the prompt-master when refA/refB are given", async () => {
    const dir = tmpDir();
    const refA = writeTinyPng(dir, "a.png");
    const refB = writeTinyPng(dir, "b.png");
    let captionCalls = 0;
    let composeSawImages = false;
    const fetchImpl = fakeLmStudio((_url, body) => {
      if (body.includes("STRICT JSON")) {
        return JSON.stringify({ both_present: true, distinct: true, bleeding: [], natural: DEFAULT_MIN_OVERALL, overall: DEFAULT_MIN_OVERALL, summary: "s" });
      }
      if (body.includes("physical appearance")) {
        captionCalls++;
        return `captioned person ${captionCalls}`;
      }
      // prompt-master call — should carry both images as image_url content entries
      // (each image contributes TWO "image_url" substrings: the {"type":"image_url"}
      // discriminator and the {"image_url":{"url":...}} key).
      composeSawImages = (body.match(/"type":"image_url"/g) ?? []).length === 2;
      return "composed prompt using both refs";
    });
    const t2i: T2iFn = async (params) => {
      const p = join(dir, `cand_${params.seed}.png`);
      writeFileSync(p, TINY_PNG);
      return { path: p, seed: params.seed };
    };

    await runTwosubjectNative({ refA, refB, candidates: 1, rounds: 1, _t2iImpl: t2i, _fetchImpl: fetchImpl, outputDir: dir });
    expect(captionCalls).toBe(2);
    expect(composeSawImages).toBe(true);
  });

  it("throws when no candidate produces a parseable score (mirrors the Python's sys.exit(1))", async () => {
    const dir = tmpDir();
    const fetchImpl = fakeLmStudio((_url, body) => (body.includes("STRICT JSON") ? "not json at all" : "a composed prompt"));
    const t2i: T2iFn = async (params) => {
      const p = join(dir, `cand_${params.seed}.png`);
      writeFileSync(p, TINY_PNG);
      return { path: p, seed: params.seed };
    };

    await expect(runTwosubjectNative({ candidates: 1, rounds: 1, _t2iImpl: t2i, _fetchImpl: fetchImpl, outputDir: dir })).rejects.toThrow(
      /no candidate produced a parseable score/,
    );
  });
});
