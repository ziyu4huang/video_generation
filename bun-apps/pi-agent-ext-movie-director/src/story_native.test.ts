import { describe, expect, it } from "bun:test";
import {
  buildAnglesPrompt,
  buildProposePrompt,
  parseAngles,
  parseProposal,
  proposalToYaml,
  conceptToStory,
  runStoryAnglesNative,
  runStoryProposeNative,
  type StoryConcept,
} from "./story_native.ts";

describe("buildAnglesPrompt / buildProposePrompt", () => {
  it("embeds the topic and count", () => {
    const p = buildAnglesPrompt("a barista's first day", 3);
    expect(p).toContain("a barista's first day");
    expect(p).toContain("exactly 3");
  });

  it("clamps count to at least 1", () => {
    const p = buildProposePrompt("renewable energy", 0);
    expect(p).toContain("exactly 1");
  });
});

describe("parseAngles / parseProposal — tolerant JSON-array extraction", () => {
  it("parses a bare JSON array", () => {
    const raw = '[{"angle":"a"},{"angle":"b"}]';
    expect(parseAngles(raw)).toEqual([{ angle: "a" }, { angle: "b" }]);
  });

  it("strips ```json fences", () => {
    const raw = '```json\n[{"angle":"a"}]\n```';
    expect(parseAngles(raw)).toEqual([{ angle: "a" }]);
  });

  it("strips <think> blocks", () => {
    const raw = '<think>reasoning here</think>\n[{"title":"x"}]';
    expect(parseProposal(raw)).toEqual([{ title: "x" }]);
  });

  it("finds the first [ ... ] amid prose", () => {
    const raw = 'Sure, here you go:\n[{"angle":"a"}]\nHope that helps!';
    expect(parseAngles(raw)).toEqual([{ angle: "a" }]);
  });

  it("throws with a helpful message when nothing parses", () => {
    expect(() => parseAngles("no json here at all")).toThrow(/no parseable JSON array/);
  });
});

describe("proposalToYaml", () => {
  it("emits valid JSON (a valid YAML subset)", () => {
    const packet: StoryConcept[] = [{ title: "x", scene_list: ["a", "b"] }];
    const yaml = proposalToYaml(packet);
    expect(JSON.parse(yaml)).toEqual(packet);
  });
});

describe("conceptToStory", () => {
  it("folds title + logline + beats into a story string", () => {
    const r = conceptToStory({
      title: "The Spark",
      logline: "A barista discovers latte art.",
      scene_list: ["she steams milk", "she pours a heart", "customer smiles"],
      visual_language: "warm, soft morning light",
      est_shot_count: 3,
    });
    expect(r.story).toBe(
      "Title: The Spark\nLogline: A barista discovers latte art.\nStory beats:\n  1. she steams milk\n  2. she pours a heart\n  3. customer smiles",
    );
    expect(r.styleHint).toBe("warm, soft morning light");
    expect(r.numPanels).toBe(3);
  });

  it("falls back to beats.length when est_shot_count is missing/invalid", () => {
    const r = conceptToStory({ scene_list: ["a", "b"] });
    expect(r.numPanels).toBe(2);
  });

  it("falls back to 4 panels when there are no beats and no est_shot_count", () => {
    const r = conceptToStory({ title: "empty" });
    expect(r.numPanels).toBe(4);
  });
});

describe("runStoryAnglesNative / runStoryProposeNative — LM Studio integration (mocked fetch)", () => {
  function fakeLmStudio(content: string): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/api/v1/models") && !url.includes("/load")) {
        return new Response(JSON.stringify({ models: [{ key: "google/gemma-4-12b", loaded_instances: [{}] }] }), { status: 200 });
      }
      if (url.includes("/models/load")) {
        return new Response(JSON.stringify({ status: "loaded" }), { status: 200 });
      }
      if (url.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it("runStoryAnglesNative returns parsed + count-clamped angles", async () => {
    const raw = JSON.stringify([
      { angle: "a", logline: "l1" },
      { angle: "b", logline: "l2" },
      { angle: "c", logline: "l3" },
    ]);
    const r = await runStoryAnglesNative("a topic", 2, { _fetchImpl: fakeLmStudio(raw) });
    expect(r.angles).toHaveLength(2);
    expect(r.angles[0]?.angle).toBe("a");
  });

  it("runStoryProposeNative returns parsed concepts", async () => {
    const raw = JSON.stringify([{ title: "T", scene_list: ["x"] }]);
    const r = await runStoryProposeNative("a topic", 2, { _fetchImpl: fakeLmStudio(raw) });
    expect(r.concepts).toEqual([{ title: "T", scene_list: ["x"] }]);
  });
});
