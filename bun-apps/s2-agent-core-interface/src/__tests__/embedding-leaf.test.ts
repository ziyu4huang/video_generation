import { afterEach, describe, expect, test } from "bun:test";
import {
  SEMANTIC_MODEL_DEFAULT,
  defaultEmbedder,
  embedQuery,
  cosine,
  splitFencedYaml,
  resolveSemanticEmbedConfig,
  type FetchLike,
} from "../embedding-leaf.js";
import { publishSeam } from "../seam.js";

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
  // Mocks are typed `FetchLike`, not `typeof fetch`. That is the contract
  // `defaultEmbedder` actually declares, and this module's header says why it
  // exists: a structural {ok,status,json} so no consumer needs DOM types. The
  // original mocks cast a zero-arg arrow to `typeof fetch`, which the checker
  // rejected twice over — the arrow has no `preconnect`, and a real `Response`
  // is not a `FetchLikeResponse` under this package's lib settings. Casting to
  // the browser type to satisfy a parameter that never wanted it was the bug.
  test("ok response → returns embeddings", async () => {
    const mockFetch: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 2] }] }),
    });
    const embed = defaultEmbedder({ baseUrl: "http://127.0.0.1:1234/", fetch: mockFetch });
    const out = await embed(["x"], SEMANTIC_MODEL_DEFAULT);
    expect(out).toEqual([[1, 2]]);
  });

  test("non-ok response → throws", async () => {
    const mockFetch: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const embed = defaultEmbedder({ baseUrl: "http://127.0.0.1:1234", fetch: mockFetch });
    await expect(embed(["x"], SEMANTIC_MODEL_DEFAULT)).rejects.toThrow("HTTP 500");
  });
});

describe("resolveSemanticEmbedConfig (D8 order: seam → env → defaults)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)["__piEmbeddingConfig"];
  });

  test("unpublished seam + no env → built-in defaults", () => {
    const r = resolveSemanticEmbedConfig({});
    expect(r.baseUrl).toBe("http://127.0.0.1:1234");
    expect(r.model).toBe("text-embedding-bge-m3");
  });

  test("env wins when the seam is unpublished (override tier for host-less runs)", () => {
    const r = resolveSemanticEmbedConfig({ SEMANTIC_EMBED_BASE: "http://127.0.0.1:8090", SEMANTIC_EMBED_MODEL: "nomic" });
    expect(r.baseUrl).toBe("http://127.0.0.1:8090");
    expect(r.model).toBe("nomic");
  });

  test("published seam wins over env — the host's baked config governs", () => {
    publishSeam("__piEmbeddingConfig", { base: "http://localhost:1234", model: "text-embedding-bge-m3" });
    const r = resolveSemanticEmbedConfig({ SEMANTIC_EMBED_BASE: "http://127.0.0.1:8090", SEMANTIC_EMBED_MODEL: "nomic" });
    expect(r.baseUrl).toBe("http://localhost:1234");
    expect(r.model).toBe("text-embedding-bge-m3");
  });

  test("blank env falls through; legacy LMSTUDIO_BASE_URL alias still honored", () => {
    const r = resolveSemanticEmbedConfig({ SEMANTIC_EMBED_BASE: "  ", LMSTUDIO_BASE_URL: "http://127.0.0.1:1235" });
    expect(r.baseUrl).toBe("http://127.0.0.1:1235");
  });
});
