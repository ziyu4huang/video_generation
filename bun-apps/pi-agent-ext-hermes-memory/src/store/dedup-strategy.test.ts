import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { MemoryDedupStrategy } from "./memory-dedup.js";
import { KnowledgeDedupStrategy } from "./knowledge-dedup.js";
import type { Card } from "./card.js";

const mk = (id: string, content: string, kind: Card["kind"] = "memory"): Card =>
  ({ id, kind, content, frontmatter: { id } });

describe("DedupStrategy", () => {
  describe("MemoryDedupStrategy", () => {
    const s = new MemoryDedupStrategy();
    it("keep when no existing match", () => {
      assert.equal(s.dedup(mk("a", "totally novel content here"), []).action, "keep");
    });
    it("skip (identity guard) when the md_id is already mirrored", () => {
      const existing = [mk("a", "prefers MLX bf16 for generation")];
      const d = s.dedup(mk("a", "prefers MLX bf16 for generation, revised"), existing);
      assert.equal(d.action, "skip");
      assert.equal(d.existingId, "a");
    });
    it("keep on exact-content duplicate with a DIFFERENT md_id (md is canonical: the md layer refuses exact dups before mirroring; distinct id ⇒ distinct row)", () => {
      const existing = [mk("a", "prefers MLX bf16 for generation")];
      const d = s.dedup(mk("b", "prefers MLX bf16 for generation"), existing);
      assert.equal(d.action, "keep");
    });
    it("keep on a near-duplicate with a different md_id (md layer warns only — the entry is still added, so the mirror must be faithful)", () => {
      const existing = [mk("a", "the mupdf renderer fails on encrypted pdfs with a permission error consistently")];
      const d = s.dedup(mk("b", "the mupdf renderer fails on encrypted pdfs with a permission error"), existing);
      assert.equal(d.action, "keep");
    });
  });
  describe("KnowledgeDedupStrategy", () => {
    const s = new KnowledgeDedupStrategy();
    it("keep when the canonical id is new", () => {
      assert.equal(s.dedup(mk("ltx:cfg", "x", "knowledge"), []).action, "keep");
    });
    it("skip (idempotent) when the canonical id already exists", () => {
      const existing = [mk("ltx:cfg", "old body", "knowledge")];
      const d = s.dedup(mk("ltx:cfg", "new body", "knowledge"), existing);
      assert.equal(d.action, "skip");
      assert.equal(d.existingId, "ltx:cfg");
    });
    it("keep when a DIFFERENT canonical id arrives even with identical body", () => {
      const existing = [mk("ltx:cfg", "same body", "knowledge")];
      assert.equal(s.dedup(mk("ltx:other", "same body", "knowledge"), existing).action, "keep");
    });
  });
});
