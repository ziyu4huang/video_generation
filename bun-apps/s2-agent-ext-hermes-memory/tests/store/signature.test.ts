/**
 * Unit tests for the pure signature-extraction helpers (UPSP §9 / ticket #06, Task 1).
 *
 * `normalizeForSignature` is the SHARED normalization used by BOTH
 * `computeSignature` (entry → signature) and the Task-5 turn-output matcher, so
 * a signature is always a substring of the identically-normalized scan text.
 * `computeSignature` returns the longest normalized sentence/line fragment whose
 * length ≥ `minChars`, or `null` when the entry is too generic to attribute.
 */
import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { normalizeForSignature, computeSignature } from "../../src/store/signature.js";

describe("signature: normalizeForSignature", () => {
  it("lowercases text", () => {
    assert.equal(normalizeForSignature("Hello WORLD FooBar"), "hello world foobar");
  });

  it("collapses runs of whitespace (spaces, tabs, newlines) to a single space", () => {
    assert.equal(
      normalizeForSignature("foo    bar\n\n\n\tbaz  qux"),
      "foo bar baz qux",
    );
    assert.equal(normalizeForSignature("a\tb  c\n d"), "a b c d");
  });

  it("trims leading/trailing whitespace", () => {
    assert.equal(normalizeForSignature("   hello   "), "hello");
    assert.equal(normalizeForSignature("\n\n  hi  \n"), "hi");
  });

  it("strips markdown code-fence delimiter lines", () => {
    assert.equal(
      normalizeForSignature("```\ncode here\n```"),
      "code here",
    );
    // Fence with info string (```ts / ```yaml) is also a delimiter line.
    assert.equal(
      normalizeForSignature("```ts\nconst x = 1\n```"),
      "const x = 1",
    );
  });

  it("strips ATX header markers (#..######)", () => {
    assert.equal(normalizeForSignature("# Title"), "title");
    assert.equal(normalizeForSignature("## Sub Heading"), "sub heading");
    assert.equal(normalizeForSignature("###### Deepest"), "deepest");
  });

  it("strips list-item markers (-, *, +)", () => {
    assert.equal(normalizeForSignature("- dash item"), "dash item");
    assert.equal(normalizeForSignature("* star item"), "star item");
    assert.equal(normalizeForSignature("+ plus item"), "plus item");
  });

  it("strips blockquote markers (>)", () => {
    assert.equal(normalizeForSignature("> quoted line"), "quoted line");
    // nested blockquote
    assert.equal(normalizeForSignature("> > nested quote"), "nested quote");
  });

  it("strips nested mixed markers (e.g. blockquote + header)", () => {
    assert.equal(normalizeForSignature("> # Quoted Heading"), "quoted heading");
    assert.equal(normalizeForSignature("- - double bullet"), "double bullet");
  });

  it("does not strip # / - / * that are not leading markdown markers", () => {
    // A hashtag-like token with no space after # is not a header.
    assert.equal(normalizeForSignature("see #release-notes for details"), "see #release-notes for details");
    // An asterisk not at line start (emphasis) is preserved.
    assert.equal(normalizeForSignature("use *emphasis* here"), "use *emphasis* here");
  });

  it("canonicalizes a mixed-case / markdown / whitespace body end-to-end", () => {
    const body = [
      "#  Project Notes",
      "",
      "```yaml",
      "key: value",
      "```",
      "-  Use   PNPM  here",
      "> Remember this rule",
    ].join("\n");
    assert.equal(
      normalizeForSignature(body),
      "project notes key: value use pnpm here remember this rule",
    );
  });

  it("returns empty string for empty / whitespace-only / marker-only input", () => {
    assert.equal(normalizeForSignature(""), "");
    assert.equal(normalizeForSignature("   \n\t  "), "");
    assert.equal(normalizeForSignature("# \n- \n> "), "# -");
  });
});

describe("signature: computeSignature", () => {
  it("returns the longest fragment that meets minChars (single long fragment)", () => {
    const body = "This entry is long enough to qualify as a signature.";
    // normalize keeps the trailing '.' (it is not a markdown marker); the
    // sentence-split drops it, so the signature is the period-less fragment.
    assert.equal(
      computeSignature(body, 24),
      "this entry is long enough to qualify as a signature",
    );
  });

  it("picks the LONGEST qualifying fragment among several sentences", () => {
    // Two sentences: one short, one long. Both fragments after split:
    //   "short"        -> len 5
    //   "this is the longest fragment in the body" -> qualifies & longest
    const body = "Short. This is the longest fragment in the body.";
    assert.equal(
      computeSignature(body, 24),
      "this is the longest fragment in the body",
    );
  });

  it("returns null when no fragment reaches minChars", () => {
    const body = "Short. Tiny bit. Mini.";
    assert.equal(computeSignature(body, 24), null);
  });

  it("skips under-min fragments but still returns a qualifying longer one", () => {
    const body = "tiny. a small lead in. here is a qualifying fragment for sure.";
    assert.equal(
      computeSignature(body, 24),
      "here is a qualifying fragment for sure",
    );
  });

  it("returns null for an empty body", () => {
    assert.equal(computeSignature("", 24), null);
  });

  it("returns null for a whitespace-only body", () => {
    assert.equal(computeSignature("   \n\t  \n", 24), null);
  });

  it("returns null when the body is only stripped-away markdown markers", () => {
    // After stripping headers/list markers/fences, nothing remains.
    assert.equal(computeSignature("# Title\n- bullet\n* item", 24), null);
  });

  it("honors a lower minChars threshold (a borderline fragment qualifies)", () => {
    // Fragment "medium length body" = 18 chars.
    const body = "Medium length body.";
    assert.equal(computeSignature(body, 24), null);
    assert.equal(computeSignature(body, 10), "medium length body");
    assert.equal(computeSignature(body, 18), "medium length body");
    assert.equal(computeSignature(body, 19), null);
  });

  it("strips markdown before fragmenting, so the signature is marker-free", () => {
    const body = "# Heading line that is plenty long on its own.";
    assert.equal(
      computeSignature(body, 24),
      "heading line that is plenty long on its own",
    );
  });

  it("signature fragment is a substring of the same body fully normalized (match contract)", () => {
    const body = "Prefix. The distinctive fragment we expect to match exactly. Suffix.";
    const sig = computeSignature(body, 24);
    assert.ok(sig !== null);
    const normalized = normalizeForSignature(body);
    assert.ok(
      normalized.includes(sig!),
      `signature "${sig}" must be a substring of normalized body "${normalized}"`,
    );
  });
});
