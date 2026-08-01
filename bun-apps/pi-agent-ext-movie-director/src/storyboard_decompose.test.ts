import { describe, expect, it } from "bun:test";
import { buildDecomposePrompt, parseDecomposition, decomposeStory } from "./storyboard_decompose.ts";

describe("buildDecomposePrompt", () => {
  it("embeds the panel count, story text, and JSON schema", () => {
    const prompt = buildDecomposePrompt("A hero's journey.", 5);
    expect(prompt).toContain("exactly 5");
    expect(prompt).toContain("A hero's journey.");
    expect(prompt).toContain('"character_id"');
  });

  it("appends a style/palette anchor line only when styleHint is given", () => {
    const withHint = buildDecomposePrompt("story", 4, "noir, teal-and-orange");
    expect(withHint).toContain("Style/palette anchor (apply to every panel): noir, teal-and-orange");
    const withoutHint = buildDecomposePrompt("story", 4);
    expect(withoutHint).not.toContain("Style/palette anchor");
  });
});

describe("parseDecomposition — tolerant JSON-array extraction", () => {
  it("parses a clean JSON array", () => {
    const scenes = parseDecomposition('[{"id":"a"},{"id":"b"}]');
    expect(scenes).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("strips <think>...</think> reasoning blocks", () => {
    const scenes = parseDecomposition('<think>reasoning here</think>[{"id":"a"}]');
    expect(scenes).toEqual([{ id: "a" }]);
  });

  it("strips ```json fences", () => {
    const scenes = parseDecomposition('```json\n[{"id":"a"}]\n```');
    expect(scenes).toEqual([{ id: "a" }]);
  });

  it("recovers a JSON array from inside an unclosed <think> block", () => {
    const scenes = parseDecomposition('<think>[{"id":"a"}]');
    expect(scenes).toEqual([{ id: "a" }]);
  });

  it("throws when no parseable array exists", () => {
    expect(() => parseDecomposition("no json here")).toThrow(/no parseable JSON array/);
  });
});

describe("decomposeStory — end-to-end via a mocked fetch", () => {
  it("calls the LM Studio chat endpoint and returns the parsed scene list, truncated to numPanels", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '[{"id":"a"},{"id":"b"},{"id":"c"}]' } }] }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const scenes = await decomposeStory("a story", { numPanels: 2, _fetchImpl: fetchImpl });
    expect(scenes).toEqual([{ id: "a" }, { id: "b" }]);
  });
});
