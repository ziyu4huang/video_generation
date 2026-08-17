import { describe, expect, test } from "bun:test";
import {
  SEMANTIC_MODEL_DEFAULT,
  defaultEmbedder,
  embedQuery,
  cosine,
  splitFencedYaml,
} from "../embedding-leaf.js";

describe("splitFencedYaml", () => {
  test("valid fence parses data and returns body", () => {
    const r = splitFencedYaml("---\na: 1\n---\nbody text");
    expect(r).not.toBeNull();
    expect(r!.data).toEqual({ a: 1 });
    expect(r!.body).toBe("body text");
  });

  test("missing fence returns null", () => {
    expect(splitFencedYaml("no fence here\njust body")).toBeNull();
    expect(splitFencedYaml("")).toBeNull();
  });

  test("malformed yaml inside fence returns null", () => {
    expect(splitFencedYaml("---\na: [unclosed\n---\nbody")).toBeNull();
  });
});

describe("cosine", () => {
  test("identical vectors → 1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("zero vector → 0", () => {
    expect(cosine([0, 0], [1, 2])).toBe(0);
  });

  test("mismatched lengths → no throw", () => {
    expect(() => cosine([1, 2], [1])).not.toThrow();
  });
});

describe("embedQuery", () => {
  test("mock embedder returns the vector", async () => {
    const mock = async (texts: string[], _model: string) => texts.map(() => [0.1, 0.2, 0.3]);
    const v = await embedQuery("hello", { embedder: mock });
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  test("no embedder → null (graceful degrade)", async () => {
    expect(await embedQuery("hello")).toBeNull();
  });
});

describe("defaultEmbedder", () => {
  test("ok response → returns embeddings", async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), { status: 200 })) as typeof fetch;
    const embed = defaultEmbedder({ baseUrl: "http://127.0.0.1:1234/", fetch: mockFetch });
    const out = await embed(["x"], SEMANTIC_MODEL_DEFAULT);
    expect(out).toEqual([[1, 2]]);
  });

  test("non-ok response → throws", async () => {
    const mockFetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const embed = defaultEmbedder({ baseUrl: "http://127.0.0.1:1234", fetch: mockFetch });
    expect(embed(["x"], SEMANTIC_MODEL_DEFAULT)).rejects.toThrow("HTTP 500");
  });
});
