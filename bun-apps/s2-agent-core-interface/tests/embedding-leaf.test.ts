/**
 * embedding-leaf.test.ts — resolveSemanticEmbedConfig contract (D3, effort
 * 2026-08-22-context-lifecycle ticket 01): the leaf is the ONE place embed
 * endpoint/model env overrides are read. Precedence:
 *   SEMANTIC_EMBED_MODEL / SEMANTIC_EMBED_BASE > legacy LMSTUDIO_BASE_URL
 *   (baseUrl only) > defaults (bge-m3 @ http://127.0.0.1:1234 — D3
 *   re-confirmed 2026-08-23 by ticket 07's eval gate; see embedding-leaf.ts).
 * Explicit-env injection (no process.env mutation, no test-order coupling).
 */
import { describe, expect, test } from "bun:test";
import {
  SEMANTIC_EMBED_BASE_DEFAULT,
  SEMANTIC_MODEL_DEFAULT,
  resolveSemanticEmbedConfig,
} from "../src/index.js";

test("canonical defaults (D3, re-confirmed by ticket 07's eval gate): bge-m3 on LM Studio :1234", () => {
  expect(SEMANTIC_MODEL_DEFAULT).toBe("text-embedding-bge-m3");
  expect(SEMANTIC_EMBED_BASE_DEFAULT).toBe("http://127.0.0.1:1234");
  const r = resolveSemanticEmbedConfig({});
  expect(r).toEqual({ baseUrl: SEMANTIC_EMBED_BASE_DEFAULT, model: SEMANTIC_MODEL_DEFAULT });
});

test("SEMANTIC_EMBED_MODEL / SEMANTIC_EMBED_BASE win", () => {
  const r = resolveSemanticEmbedConfig({
    SEMANTIC_EMBED_MODEL: " text-embedding-nomic-embed-text-v1.5 ",
    SEMANTIC_EMBED_BASE: "http://127.0.0.1:8090",
  });
  expect(r).toEqual({
    baseUrl: "http://127.0.0.1:8090", // trimmed; :8090 = the documented fallback endpoint
    model: "text-embedding-nomic-embed-text-v1.5",
  });
});

test("LMSTUDIO_BASE_URL honored as legacy baseUrl alias, never as model", () => {
  const r = resolveSemanticEmbedConfig({ LMSTUDIO_BASE_URL: "http://localhost:9999" });
  expect(r.baseUrl).toBe("http://localhost:9999");
  expect(r.model).toBe(SEMANTIC_MODEL_DEFAULT);
});

test("SEMANTIC_EMBED_BASE outranks the legacy alias; blank values fall through", () => {
  const r = resolveSemanticEmbedConfig({
    SEMANTIC_EMBED_BASE: "http://127.0.0.1:8090",
    LMSTUDIO_BASE_URL: "http://localhost:9999",
  });
  expect(r.baseUrl).toBe("http://127.0.0.1:8090");
  expect(resolveSemanticEmbedConfig({ SEMANTIC_EMBED_BASE: "   " }).baseUrl).toBe(
    SEMANTIC_EMBED_BASE_DEFAULT,
  );
});
