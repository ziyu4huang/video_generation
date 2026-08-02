/**
 * Unit tests for the used-detection trigger — SurfacedSignatureSet +
 * setupUsedDetection (UPSP §9 / ticket #06, Task 5).
 *
 * `SurfacedSignatureSet` holds the surfaced-entry signatures → mdId map
 * (populated once at session_start by Task 6 from the SAME receipt #05
 * recorded) and matches them against the turn's normalized assistant output,
 * forgetting matches monotonically. `setupUsedDetection` buffers assistant
 * `message_end` text and, at `turn_end`, scans it and calls
 * `sessionRepo.markUsed`. Best-effort, DB-authoritative, mirrors
 * worth-scoring's safety envelope.
 *
 * The matcher reuses the REAL `SurfacedSignatureSet` + `normalizeForSignature`
 * + `computeSignature` (no mocking the normalization DRY contract). `pi`,
 * `sessionRepo`, and `getSessionId` are stubs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SurfacedSignatureSet, setupUsedDetection } from "../../src/handlers/used-detection.js";
import { computeSignature, normalizeForSignature } from "../../src/store/signature.js";

/** A representative entry body whose longest fragment comfortably exceeds the
 *  default `usedSignatureMinChars` (24). Used to mint real signatures. */
const BODY_A = "Always pin the MLX dtype to bfloat16 for native Apple Silicon support.";
const SIG_A = computeSignature(BODY_A, 24)!;
const BODY_B = "Run the full bun test suite from the bun-apps workspace root only.";
const SIG_B = computeSignature(BODY_B, 24)!;

type MarkUsedCall = { sid: string; mdIds: string[]; usedAt: string };

interface Harness {
  surfaced: SurfacedSignatureSet;
  calls: MarkUsedCall[];
  fire: (ev: string, e: any, ctx?: any) => Promise<void>;
}

/** Build a stub `pi` + `sessionRepo` + `getSessionId`, wire setupUsedDetection,
 *  return the handler registry, the real SurfacedSignatureSet, and a recorder
 *  of markUsed calls. */
function makeHarness(opts: {
  config?: any;
  sid?: string | null;
  getSessionId?: () => string | null;
  markUsedImpl?: (sid: string, mdIds: readonly string[], usedAt: string) => Promise<void> | void;
} = {}): Harness {
  const handlers: Record<string, Array<(e: any, ctx?: any) => Promise<void> | void>> = {};
  const pi: any = {
    on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); },
    registerTool() {}, registerCommand() {},
  };
  const surfaced = new SurfacedSignatureSet();
  const calls: MarkUsedCall[] = [];
  const getSessionId = opts.getSessionId ?? (() => (opts.sid !== undefined ? opts.sid : "sess-1"));
  const repo: any = {
    markUsed: opts.markUsedImpl
      ? (async (sid: string, mdIds: readonly string[], usedAt: string) =>
          opts.markUsedImpl!(sid, mdIds, usedAt))
      : (async (sid: string, mdIds: readonly string[], usedAt: string) =>
          calls.push({ sid, mdIds: [...mdIds], usedAt })),
  };
  setupUsedDetection(pi, repo, surfaced, opts.config ?? {}, getSessionId);
  const fire = async (ev: string, e: any, ctx?: any) => {
    for (const h of handlers[ev] ?? []) await h(e, ctx);
  };
  return { surfaced, calls, fire };
}

describe("SurfacedSignatureSet", () => {
  it("populate replaces the whole set (not additive)", () => {
    const set = new SurfacedSignatureSet();
    set.populate([
      { mdId: "a", signature: SIG_A },
      { mdId: "b", signature: SIG_B },
    ]);
    assert.strictEqual(set.matchAndForget(normalizeForSignature(BODY_A)).length, 1);
    set.populate([{ mdId: "c", signature: "gamma signature three" }]);
    // alpha/beta are gone after the second populate; only c remains.
    assert.deepEqual(
      set.matchAndForget(normalizeForSignature(`${BODY_A} ${BODY_B}`)).sort(),
      [],
    );
    assert.deepEqual(
      set.matchAndForget(normalizeForSignature("...gamma signature three...")),
      ["c"],
    );
  });

  it("matchAndForget returns matched mdIds and removes them; unmatched stay", () => {
    const set = new SurfacedSignatureSet();
    set.populate([
      { mdId: "a", signature: SIG_A },
      { mdId: "b", signature: SIG_B },
    ]);
    const matched = set.matchAndForget(normalizeForSignature(`notes say: ${BODY_A}`));
    assert.deepEqual(matched, ["a"]);
    // 'a' forgotten; 'b' still detectable on a later scan.
    assert.deepEqual(set.matchAndForget(normalizeForSignature(BODY_B)), ["b"]);
  });

  it("multi-match in one call returns all matched mdIds", () => {
    const set = new SurfacedSignatureSet();
    set.populate([
      { mdId: "a", signature: SIG_A },
      { mdId: "b", signature: SIG_B },
    ]);
    const matched = set
      .matchAndForget(normalizeForSignature(`So ${BODY_A} and also ${BODY_B}.`))
      .sort();
    assert.deepEqual(matched, ["a", "b"]);
  });

  it("monotonic: re-scanning the same text returns [] (already forgotten)", () => {
    const set = new SurfacedSignatureSet();
    set.populate([{ mdId: "a", signature: SIG_A }]);
    assert.deepEqual(set.matchAndForget(normalizeForSignature(BODY_A)), ["a"]);
    assert.deepEqual(set.matchAndForget(normalizeForSignature(BODY_A)), []);
  });

  it("empty / whitespace text returns [] and mutates nothing", () => {
    const set = new SurfacedSignatureSet();
    set.populate([{ mdId: "a", signature: SIG_A }]);
    assert.deepEqual(set.matchAndForget(""), []);
    assert.deepEqual(set.matchAndForget(normalizeForSignature("    \n\t  ")), []);
    // set intact
    assert.deepEqual(set.matchAndForget(normalizeForSignature(BODY_A)), ["a"]);
  });
});

describe("setupUsedDetection", () => {
  it("assistant message containing a surfaced signature → markUsed at turn_end", async () => {
    const h = makeHarness();
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("message_end", {
      message: { role: "assistant", content: `Sure — ${BODY_A} when loading.` },
    });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 1);
    assert.strictEqual(h.calls[0].sid, "sess-1");
    assert.deepEqual(h.calls[0].mdIds, ["md-a"]);
    // usedAt is an ISO timestamp.
    assert.ok(!Number.isNaN(Date.parse(h.calls[0].usedAt)));
  });

  it("accumulates multiple assistant messages in one turn before scanning", async () => {
    const h = makeHarness();
    h.surfaced.populate([
      { mdId: "md-a", signature: SIG_A },
      { mdId: "md-b", signature: SIG_B },
    ]);
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await h.fire("message_end", { message: { role: "assistant", content: BODY_B } });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 1);
    assert.deepEqual(h.calls[0].mdIds.sort(), ["md-a", "md-b"]);
  });

  it("no-match: assistant text without any signature → markUsed NOT called; set unchanged", async () => {
    const h = makeHarness();
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("message_end", {
      message: { role: "assistant", content: "Hello, how can I help today?" },
    });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 0);
    // signature still present
    assert.deepEqual(h.surfaced.matchAndForget(normalizeForSignature(BODY_A)), ["md-a"]);
  });

  it("monotonic across turns: matched once in turn 1, NOT re-marked in turn 2", async () => {
    const h = makeHarness();
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    // turn 1
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 1);
    // turn 2 — same text, but signature already forgotten
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 1); // still just the one call
  });

  it("role filter: a USER message_end does NOT contribute to the buffer", async () => {
    const h = makeHarness();
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    // user message containing the signature text — must be ignored
    await h.fire("message_end", { message: { role: "user", content: BODY_A } });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 0);
    // set intact (nothing forgotten)
    assert.deepEqual(h.surfaced.matchAndForget(normalizeForSignature(BODY_A)), ["md-a"]);
  });

  it("best-effort: a throwing markUsed is swallowed (no throw escapes turn_end)", async () => {
    const h = makeHarness({
      markUsedImpl: () => { throw new Error("boom"); },
    });
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    // must not throw
    await assert.doesNotReject(() => h.fire("turn_end", {}, {}));
  });

  it("best-effort: a throwing getSessionId is swallowed", async () => {
    const h = makeHarness({ getSessionId: () => { throw new Error("no sid"); } });
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await assert.doesNotReject(() => h.fire("turn_end", {}, {}));
    assert.strictEqual(h.calls.length, 0);
  });

  it("best-effort: a throwing getMessageText path (throwing content) is swallowed", async () => {
    const h = makeHarness();
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    // a message whose `.content` access throws — getMessageText re-throws, the
    // message_end handler's try/catch must swallow it (no escape, no match).
    const boom: any = { role: "assistant" };
    Object.defineProperty(boom, "content", {
      get() { throw new Error("content exploded"); },
      enumerable: true,
    });
    await assert.doesNotReject(() => h.fire("message_end", { message: boom }));
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 0);
    // set intact
    assert.deepEqual(h.surfaced.matchAndForget(normalizeForSignature(BODY_A)), ["md-a"]);
  });

  it("disabled (usedDetection===false): message_end no-ops, turn_end no-ops, markUsed never called", async () => {
    const h = makeHarness({ config: { usedDetection: false } });
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 0);
    // set untouched — even though it had matches, the disabled turn mutated nothing
    assert.deepEqual(h.surfaced.matchAndForget(normalizeForSignature(BODY_A)), ["md-a"]);
  });

  it("empty turn (no assistant message) → markUsed not called", async () => {
    const h = makeHarness();
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 0);
    assert.deepEqual(h.surfaced.matchAndForget(normalizeForSignature(BODY_A)), ["md-a"]);
  });

  it("no sid → markUsed skipped (but signature still forgotten for the scan)", async () => {
    const h = makeHarness({ sid: null });
    h.surfaced.populate([{ mdId: "md-a", signature: SIG_A }]);
    await h.fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await h.fire("turn_end", {}, {});
    assert.strictEqual(h.calls.length, 0);
    // matched-and-forgotten even though markUsed was skipped (scan is monotonic)
    assert.deepEqual(h.surfaced.matchAndForget(normalizeForSignature(BODY_A)), []);
  });
});
