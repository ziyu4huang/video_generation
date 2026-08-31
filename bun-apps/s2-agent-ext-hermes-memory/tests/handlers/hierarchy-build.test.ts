/**
 * tests/handlers/hierarchy-build.test.ts — 04b-2 pure builder unit tests.
 *
 * buildHierarchyCall is the PURE skip/arg resolver for the fire-and-forget
 * hierarchy hook. Covers the three skip guards (no kbDir / disabled knob /
 * no embedFn — all evaluated BEFORE the seam presence check, so no seam
 * needed) plus the all-present happy path (requires the __piKnowledgePipeline
 * seam slot — published as a minimal fake and ALWAYS cleaned up afterwards:
 * bun runs every test file in one process, so a leaked slot would poison
 * other files' graceful-absence paths).
 *
 * Plain fakes only — no mock framework, no store, no LLM.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { buildHierarchyCall, fireHierarchyBuildBestEffort } from "../../src/handlers/hierarchy-build.js";
import { publishSeam, type KnowledgePipeline } from "@repo/s2-agent-core-interface";

/** Publish a minimal fake seam impl (buildHierarchyCall only checks
 *  PRESENCE — `void kp` — so an empty object suffices). */
function withSeam(): void {
  publishSeam("__piKnowledgePipeline", {} as KnowledgePipeline);
}

/** Publish a recording fake seam: buildHierarchy resolves `buildResult`,
 *  healGraph resolves a receipt; every call is pushed onto `calls` so tests
 *  can pin the build→heal ORDER (the 2026-08-31 MOC-staleness fix). */
function withRecordingSeam(
  calls: string[],
  buildResult: { layers: number; nodes: unknown[]; llmCalls: number; resumed: boolean; skipped?: string },
  healImpl?: () => Promise<unknown>,
): void {
  publishSeam("__piKnowledgePipeline", {
    buildHierarchy: async (_opts: unknown) => {
      calls.push("buildHierarchy");
      return buildResult;
    },
    healGraph: async (opts: unknown) => {
      calls.push(`healGraph:${JSON.stringify(opts)}`);
      return healImpl ? await healImpl() : { mocRegenerated: true, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] };
    },
  } as unknown as KnowledgePipeline);
}

/** Plain fake embedFn: deterministic vectors, no network. */
const fakeEmbedFn = async (texts: string[]): Promise<number[][]> => texts.map(() => [0, 1]);

/** Plain fake summarizeFn: deterministic truncation, no LLM. */
const fakeSummarizeFn = async (clusterText: string, budget: number): Promise<string> =>
  clusterText.slice(0, budget);

// Defensive both ways: clear the slot before AND after each test so neither
// an earlier file's leak nor our own setup survives this file.
afterEach(() => {
  delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
});

describe("buildHierarchyCall — skip guards (pure, no seam)", () => {
  it("returns null when kbDir is undefined", () => {
    const call = buildHierarchyCall(undefined, { embedFn: fakeEmbedFn });
    expect(call).toBeNull();
  });

  it("returns null when enabled === false (the hierarchyEnabled knob)", () => {
    const call = buildHierarchyCall("/tmp/kb", { embedFn: fakeEmbedFn, enabled: false });
    expect(call).toBeNull();
  });

  it("returns null when embedFn is absent (embeds unavailable)", () => {
    const call = buildHierarchyCall("/tmp/kb", {});
    expect(call).toBeNull();
  });
});

describe("buildHierarchyCall — all-present (seam published)", () => {
  it("returns {kbDir, embedFn}; threshold/maxDepth/tokenBudget absent when undefined, present when given", async () => {
    withSeam();

    // Bare: no optional knobs → the three keys are ABSENT (spread-conditional),
    // and the injected embedFn is passed through as the live callable.
    const bare = buildHierarchyCall("/tmp/kb", { embedFn: fakeEmbedFn });
    expect(bare).not.toBeNull();
    expect(bare!.kbDir).toBe("/tmp/kb");
    expect(bare!.embedFn).toBe(fakeEmbedFn);
    expect(await bare!.embedFn(["x"])).toEqual([[0, 1]]); // it IS our fake
    expect("threshold" in bare!).toBe(false);
    expect("maxDepth" in bare!).toBe(false);
    expect("tokenBudget" in bare!).toBe(false);

    // Full: knobs given → present with the given values.
    const full = buildHierarchyCall("/tmp/kb", {
      embedFn: fakeEmbedFn,
      threshold: 0.72,
      maxDepth: 5,
      tokenBudget: 512,
    });
    expect(full).not.toBeNull();
    expect(full!.kbDir).toBe("/tmp/kb");
    expect(full!.threshold).toBe(0.72);
    expect(full!.maxDepth).toBe(5);
    expect(full!.tokenBudget).toBe(512);
  });

  it("summarizeFn pass-through: present when given, key undefined when omitted", async () => {
    withSeam();

    // Given → the exact injected callable.
    const withSum = buildHierarchyCall("/tmp/kb", { embedFn: fakeEmbedFn, summarizeFn: fakeSummarizeFn });
    expect(withSum).not.toBeNull();
    expect(withSum!.summarizeFn).toBe(fakeSummarizeFn);
    expect(await withSum!.summarizeFn!("abcdef", 3)).toBe("abc"); // it IS our fake

    // Omitted → key exists but is undefined (zk falls back to its own
    // deterministic default summarizer).
    const withoutSum = buildHierarchyCall("/tmp/kb", { embedFn: fakeEmbedFn });
    expect(withoutSum).not.toBeNull();
    expect(withoutSum!.summarizeFn).toBeUndefined();
  });
});

describe("fireHierarchyBuildBestEffort — post-build MOC heal (2026-08-31 fix)", () => {
  it("a completed build is followed by healGraph with the heal target (order-pinned)", async () => {
    const calls: string[] = [];
    withRecordingSeam(calls, { layers: 2, nodes: [{}, {}], llmCalls: 0, resumed: false });
    await fireHierarchyBuildBestEffort(
      "/vault/Zettelkasten/knowledge-graph",
      { embedFn: fakeEmbedFn },
      { vaultPath: "/vault", folder: "Zettelkasten/knowledge-graph", mocPath: "Tags/Knowledge Graph.md" },
    );
    expect(calls).toEqual([
      "buildHierarchy",
      'healGraph:{"vaultPath":"/vault","folder":"Zettelkasten/knowledge-graph","mocPath":"Tags/Knowledge Graph.md"}',
    ]);
  });

  it("heal target omitted (legacy call shape) → build only, no healGraph call", async () => {
    const calls: string[] = [];
    withRecordingSeam(calls, { layers: 1, nodes: [{}], llmCalls: 0, resumed: false });
    await fireHierarchyBuildBestEffort("/vault/Zettelkasten/knowledge-graph", { embedFn: fakeEmbedFn });
    expect(calls).toEqual(["buildHierarchy"]);
  });

  it("skipped build (e.g. no-entities) → NO heal — the MOC state is untouched", async () => {
    const calls: string[] = [];
    withRecordingSeam(calls, { layers: 0, nodes: [], llmCalls: 0, resumed: false, skipped: "no-entities" });
    await fireHierarchyBuildBestEffort(
      "/vault/Zettelkasten/knowledge-graph",
      { embedFn: fakeEmbedFn },
      { vaultPath: "/vault", folder: "Zettelkasten/knowledge-graph" },
    );
    expect(calls).toEqual(["buildHierarchy"]);
  });

  it("healGraph failure is isolated — the promise still resolves and the failure is NOT the build's", async () => {
    const calls: string[] = [];
    withRecordingSeam(
      calls,
      { layers: 1, nodes: [{}], llmCalls: 0, resumed: false },
      () => Promise.reject(new Error("vault busy")),
    );
    // Must not reject (best-effort contract) and must not lose the build.
    await fireHierarchyBuildBestEffort(
      "/vault/Zettelkasten/knowledge-graph",
      { embedFn: fakeEmbedFn },
      { vaultPath: "/vault", folder: "Zettelkasten/knowledge-graph" },
    );
    expect(calls).toEqual([
      "buildHierarchy",
      'healGraph:{"vaultPath":"/vault","folder":"Zettelkasten/knowledge-graph"}',
    ]);
  });

  it("skip guards still short-circuit before the seam (no kbDir → zero seam calls)", async () => {
    const calls: string[] = [];
    withRecordingSeam(calls, { layers: 1, nodes: [{}], llmCalls: 0, resumed: false });
    await fireHierarchyBuildBestEffort(undefined, { embedFn: fakeEmbedFn }, { vaultPath: "/vault", folder: "f" });
    expect(calls).toEqual([]);
  });
});
