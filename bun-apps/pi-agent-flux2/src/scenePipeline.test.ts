import { describe, expect, test } from "bun:test";
import { runScenePipeline, type ScenePipelineOptions } from "./scenePipeline.ts";
import type { Flux2Details } from "./result.ts";

function fakeDetails(overrides: Partial<Flux2Details> = {}): Flux2Details {
  return {
    ok: true,
    command: "scene",
    exitCode: 0,
    aborted: false,
    output: "/out/seed.png",
    outputs: [],
    seed: null,
    width: 1024,
    height: 1024,
    gate: "PASS",
    perf: { steps: null, totalSeconds: null, avgItPerSec: null, peakMemoryMB: null },
    manifestPath: null,
    runJsonPath: null,
    ...overrides,
  };
}

describe("runScenePipeline", () => {
  test("throws when seeds is empty", async () => {
    await expect(
      runScenePipeline({}, { seeds: [] } as ScenePipelineOptions, {
        runSceneOnce: async () => fakeDetails(),
        askAboutImage: async () => ({ reply: "", ok: true }),
      }),
    ).rejects.toThrow(/non-empty array/);
  });

  test("renders one candidate per seed, passing the seed override through", async () => {
    const seenSeeds: number[] = [];
    const result = await runScenePipeline(
      { prompt: "a scene" },
      { seeds: [1, 2, 3] },
      {
        runSceneOnce: async (opts) => {
          seenSeeds.push(opts.seed as number);
          return fakeDetails({ output: `/out/${opts.seed}.png` });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(seenSeeds).toEqual([1, 2, 3]);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((c) => c.seed)).toEqual([1, 2, 3]);
  });

  test("skips VLM verification entirely when verifyPrompt is omitted", async () => {
    let askCalls = 0;
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2] },
      {
        runSceneOnce: async () => fakeDetails(),
        askAboutImage: async () => {
          askCalls++;
          return { reply: "irrelevant", ok: true };
        },
      },
    );
    expect(askCalls).toBe(0);
    expect(result.candidates.every((c) => c.vlmReply === null)).toBe(true);
    // No verifyMatch → falls back to best-gate.
    expect(result.winnerReason).toBe("best-gate");
    expect(result.winnerSeed).toBe(1);
  });

  test("picks the first seed (in order) whose VLM reply matches every verifyMatch substring", async () => {
    const replies: Record<number, string> = {
      100: "girl A wears a bun and is writing at a desk; girl B wears braids and is standing",
      137: "girl A wears a ponytail and is reading a book; girl B is standing near the window", // matches
      174: "girl A wears a ponytail and is reading; girl B wears a ponytail and is reading too",
    };
    const result = await runScenePipeline(
      {},
      { seeds: [100, 137, 174], verifyPrompt: "describe", verifyMatch: ["ponytail", "reading"] },
      {
        runSceneOnce: async (opts) => fakeDetails({ output: `/out/${opts.seed}.png` }),
        askAboutImage: async (_img, _q) => {
          const seed = Number(_img.match(/(\d+)\.png$/)![1]);
          return { reply: replies[seed]!, ok: true };
        },
      },
    );
    expect(result.winnerReason).toBe("verify-match");
    expect(result.winnerSeed).toBe(137);
    expect(result.candidates.find((c) => c.seed === 137)?.matched).toBe(true);
    expect(result.candidates.find((c) => c.seed === 100)?.matched).toBe(false);
  });

  test("falls back to best-gate when no candidate matches verifyMatch", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2], verifyPrompt: "describe", verifyMatch: ["nonexistent-phrase"] },
      {
        runSceneOnce: async (opts) =>
          fakeDetails({ gate: opts.seed === 2 ? "PASS" : "WARN", output: `/out/${opts.seed}.png` }),
        askAboutImage: async () => ({ reply: "no match here", ok: true }),
      },
    );
    expect(result.winnerReason).toBe("best-gate");
    expect(result.winnerSeed).toBe(2);
  });

  test("a matched but gate-FAILed candidate is not picked by verify-match; falls back to best-gate", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2], verifyPrompt: "describe", verifyMatch: ["ok"] },
      {
        runSceneOnce: async (opts) =>
          fakeDetails({ gate: opts.seed === 1 ? "FAIL" : "PASS", output: `/out/${opts.seed}.png` }),
        // Only seed 1 (FAILed) matches; seed 2 (PASS) doesn't — so no valid
        // non-FAIL match exists and the pipeline must fall back to best-gate.
        askAboutImage: async (_img, _q) => ({ reply: _img.includes("/1.png") ? "ok" : "nope", ok: true }),
      },
    );
    expect(result.winnerReason).toBe("best-gate");
    expect(result.winnerSeed).toBe(2);
  });

  test("ignores candidates where the run itself failed (ok=false) when picking best-gate", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2] },
      {
        runSceneOnce: async (opts) =>
          fakeDetails({ ok: opts.seed !== 1, gate: opts.seed === 1 ? "PASS" : "WARN", output: `/out/${opts.seed}.png` }),
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.winnerSeed).toBe(2);
  });

  test("returns winnerReason 'none' and null winner when every candidate failed", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2] },
      {
        runSceneOnce: async () => fakeDetails({ ok: false, output: null, gate: null }),
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.winnerReason).toBe("none");
    expect(result.winnerSeed).toBeNull();
    expect(result.winnerOutput).toBeNull();
  });

  test("hand-repairs the winner when handRepairWinner is set, reusing its seed + baseOptions", async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await runScenePipeline(
      { prompt: "a scene" },
      { seeds: [1, 2], handRepairWinner: true },
      {
        runSceneOnce: async (opts) => {
          calls.push(opts);
          const isRepair = opts.handRepair === true;
          return fakeDetails({
            gate: "PASS",
            output: isRepair ? `/out/${opts.seed}-repaired.png` : `/out/${opts.seed}.png`,
          });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.winnerSeed).toBe(1);
    expect(result.handRepair?.output).toBe("/out/1-repaired.png");
    // 2 seed renders + 1 hand-repair pass.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ prompt: "a scene", seed: 1, handRepair: true });
  });

  test("does not hand-repair when handRepairWinner is false/omitted", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1] },
      {
        runSceneOnce: async (opts) => fakeDetails({ output: `/out/${opts.seed}.png` }),
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.handRepair).toBeUndefined();
  });

  test("appends a per-seed suffix to a caller-supplied `name` so seeds never overwrite each other's file", async () => {
    const seenNames: unknown[] = [];
    await runScenePipeline(
      { prompt: "a scene", name: "my_scene" },
      { seeds: [11, 22] },
      {
        runSceneOnce: async (opts) => {
          seenNames.push(opts.name);
          return fakeDetails({ output: `/out/${opts.name}.png` });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(seenNames).toEqual(["my_scene_seed11", "my_scene_seed22"]);
  });

  test("appends a per-seed suffix to a caller-supplied `output` path (before the extension)", async () => {
    const seenOutputs: unknown[] = [];
    await runScenePipeline(
      { prompt: "a scene", output: "/out/fixed.png" },
      { seeds: [11, 22] },
      {
        runSceneOnce: async (opts) => {
          seenOutputs.push(opts.output);
          return fakeDetails();
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(seenOutputs).toEqual(["/out/fixed_seed11.png", "/out/fixed_seed22.png"]);
  });

  test("leaves `name`/`output` untouched when the caller omits them (CLI's own timestamped default applies)", async () => {
    const seenOpts: Record<string, unknown>[] = [];
    await runScenePipeline(
      { prompt: "a scene" },
      { seeds: [1] },
      {
        runSceneOnce: async (opts) => {
          seenOpts.push(opts);
          return fakeDetails();
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(seenOpts[0]).not.toHaveProperty("name");
    expect(seenOpts[0]).not.toHaveProperty("output");
  });

  test("the hand-repair pass gets its own distinct name, not the winner's original seed name", async () => {
    const seenNames: unknown[] = [];
    const result = await runScenePipeline(
      { prompt: "a scene", name: "my_scene" },
      { seeds: [1], handRepairWinner: true },
      {
        runSceneOnce: async (opts) => {
          seenNames.push(opts.name);
          return fakeDetails({ output: `/out/${opts.name}.png` });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(seenNames).toEqual(["my_scene_seed1", "my_scene_seed1_handrepair"]);
    expect(result.handRepair?.output).toBe("/out/my_scene_seed1_handrepair.png");
  });

  test("does not call the VLM for a candidate whose run failed", async () => {
    let askCalls = 0;
    await runScenePipeline(
      {},
      { seeds: [1], verifyPrompt: "describe" },
      {
        runSceneOnce: async () => fakeDetails({ ok: false, output: null }),
        askAboutImage: async () => {
          askCalls++;
          return { reply: "", ok: true };
        },
      },
    );
    expect(askCalls).toBe(0);
  });

  test("a per-seed `output` suffix splits on the BASENAME's extension, not a dot in a parent directory", () => {
    // Regression: a directory name containing a dot (e.g. a versioned output
    // dir "/out.v2") used to be mistaken for the file extension separator.
    const seenOutputs: unknown[] = [];
    return runScenePipeline(
      { prompt: "a scene", output: "/out.v2/render" },
      { seeds: [5] },
      {
        runSceneOnce: async (opts) => {
          seenOutputs.push(opts.output);
          return fakeDetails();
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    ).then(() => {
      expect(seenOutputs).toEqual(["/out.v2/render_seed5"]);
    });
  });

  test("winnerGate is the ACTUAL winning candidate's gate, not a re-lookup by seed value (duplicate seeds)", async () => {
    // Regression: re-deriving the gate via candidates.find(seed === winnerSeed)
    // picks the FIRST candidate with that seed, which can differ from the
    // candidate pickWinner() actually selected when seeds repeat.
    let call = 0;
    const result = await runScenePipeline(
      {},
      { seeds: [9, 9] },
      {
        runSceneOnce: async (opts) => {
          call++;
          // First seed-9 render gates WARN, second (also seed 9) gates PASS.
          return fakeDetails({ gate: call === 1 ? "WARN" : "PASS", output: `/out/9-${call}.png` });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.winnerOutput).toBe("/out/9-2.png"); // the PASS render
    expect(result.winnerGate).toBe("PASS");
  });

  test("winnerGate is null and handRepair.gate wins when hand-repair's own gate check fails to parse", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1], handRepairWinner: true },
      {
        runSceneOnce: async (opts) =>
          fakeDetails({
            gate: opts.handRepair ? null : "WARN", // repair succeeds but its gate sub-check returns null
            output: opts.handRepair ? "/out/1-repaired.png" : "/out/1.png",
          }),
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.winnerGate).toBe("WARN");
    expect(result.handRepair?.gate).toBeNull();
    expect(result.handRepair?.output).toBe("/out/1-repaired.png");
  });

  test("a throwing seed render does not discard already-rendered candidates — the pipeline still returns a partial result", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2, 3] },
      {
        runSceneOnce: async (opts) => {
          if (opts.seed === 2) throw new Error("boom: binary crashed");
          return fakeDetails({ output: `/out/${opts.seed}.png` });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]).toMatchObject({ seed: 1, ok: true });
    expect(result.candidates[1]).toMatchObject({ seed: 2, ok: false, output: null, gate: null });
    expect(result.candidates[2]).toMatchObject({ seed: 3, ok: true });
    // Winner still gets picked from the surviving candidates.
    expect(result.winnerSeed).not.toBeNull();
  });

  test("a throwing VLM call degrades to no-verdict for that seed instead of killing the whole pipeline", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2], verifyPrompt: "describe" },
      {
        runSceneOnce: async (opts) => fakeDetails({ output: `/out/${opts.seed}.png` }),
        askAboutImage: async (img) => {
          if (img === "/out/1.png") throw new Error("LM Studio unreachable");
          return { reply: "ok", ok: true };
        },
      },
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ seed: 1, ok: true, vlmReply: null, matched: false });
    expect(result.candidates[1]).toMatchObject({ seed: 2, ok: true, vlmReply: "ok" });
  });

  test("a throwing hand-repair pass degrades to a null repair result instead of discarding the already-found winner", async () => {
    const result = await runScenePipeline(
      {},
      { seeds: [1], handRepairWinner: true },
      {
        runSceneOnce: async (opts) => {
          if (opts.handRepair) throw new Error("flux2 binary crashed on --hand-repair");
          return fakeDetails({ output: "/out/1.png", gate: "WARN" });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
    );
    expect(result.winnerSeed).toBe(1);
    expect(result.winnerOutput).toBe("/out/1.png");
    expect(result.winnerGate).toBe("WARN");
    expect(result.handRepair).toEqual({ output: null, gate: null });
  });

  test("stops rendering remaining seeds once the AbortSignal fires, instead of spawning+killing every remaining one", async () => {
    const controller = new AbortController();
    const renderedSeeds: number[] = [];
    const result = await runScenePipeline(
      {},
      { seeds: [1, 2, 3, 4, 5] },
      {
        runSceneOnce: async (opts) => {
          renderedSeeds.push(opts.seed as number);
          if (opts.seed === 2) controller.abort(); // abort mid-run, after seed 2 renders
          return fakeDetails({ output: `/out/${opts.seed}.png` });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
      undefined,
      controller.signal,
    );
    // Seeds 1 and 2 render (2 triggers the abort); 3/4/5 must be skipped entirely.
    expect(renderedSeeds).toEqual([1, 2]);
    expect(result.candidates).toHaveLength(2);
  });

  test("an abort that fires after seeds finish rendering still skips the hand-repair pass", async () => {
    // Isolates the hand-repair-specific abort check from the render-loop one:
    // a winner IS found (seed 1 renders successfully), but the signal fires
    // between the render loop and the hand-repair step.
    const controller = new AbortController();
    const calls: unknown[] = [];
    const result = await runScenePipeline(
      {},
      { seeds: [1], handRepairWinner: true },
      {
        runSceneOnce: async (opts) => {
          calls.push(opts);
          if (!opts.handRepair) controller.abort();
          return fakeDetails({ output: `/out/${opts.seed}.png`, gate: "WARN" });
        },
        askAboutImage: async () => ({ reply: "", ok: true }),
      },
      undefined,
      controller.signal,
    );
    expect(calls).toHaveLength(1); // only the seed render — hand-repair never called
    expect(result.winnerSeed).toBe(1);
    expect(result.handRepair).toBeUndefined();
  });
});
