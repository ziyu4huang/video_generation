/**
 * Task 6 — session_start wiring of the "used vs dropped" signal (UPSP §9 / §5↔§9 join).
 *
 * Drives the integration of three pieces that Task 6 connects:
 *
 *   1. `captureAssembly` (#05) — now extended with an optional `onReceipt`
 *      callback so the SAME prompt-assembly receipt that gets recorded also
 *      feeds the surfaced-signature set (Problem A: share ONE build, no
 *      double-render of `buildPromptAssembly`).
 *   2. `SurfacedSignatureSet` (Task 5) — populated from the receipt's
 *      `signatures` via that callback.
 *   3. `setupUsedDetection` (Task 5) — reads the populated set at `turn_end`
 *      and calls `sessionRepo.markUsed` on matches (Problem B: getSessionId is
 *      supplied via a holder bound at extension-setup).
 *
 * The defining correctness property of #06 is the §5↔§9 join invariant: the
 * surfaced mdIds the matcher tracks == the mdIds #05 persisted in
 * session_assembly, because both derive from the SAME receipt (captureAssembly
 * calls build ONCE). These tests assert that invariant directly.
 *
 * `pi`, `sessionRepo.record`/`markUsed`, and `getSessionId` are stubs; the
 * `SurfacedSignatureSet`, `captureAssembly`, `setupUsedDetection`,
 * `buildPromptAssembly`, `computeSignature`, and `normalizeForSignature` under
 * test are the REAL implementations (the normalization-DRY contract + the
 * single-build invariant must hold on the real code paths).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { captureAssembly } from "../../src/handlers/session-assembly.js";
import { SurfacedSignatureSet, setupUsedDetection } from "../../src/handlers/used-detection.js";
import { buildPromptAssembly } from "../../src/prompt-context.js";
import { computeSignature, normalizeForSignature } from "../../src/store/signature.js";
import type { MemoryStore } from "../../src/store/memory-store.js";

/** A body whose longest fragment comfortably exceeds the default min (24). */
const BODY_A = "Always pin the MLX dtype to bfloat16 for native Apple Silicon support.";
const BODY_B = "Run the full bun test suite from the bun-apps workspace root only.";
const SIG_A = computeSignature(BODY_A, 24)!;
const SIG_B = computeSignature(BODY_B, 24)!;
const MD_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MD_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

type Signature = { mdId: string; signature: string };
type RecordCall = { sid: string; mdIds: string[]; hash: string };
type MarkUsedCall = { sid: string; mdIds: string[]; usedAt: string };

/** Minimal MemoryStore stub exposing only the two assembly-manifest methods
 *  consumed by buildPromptAssembly (same shape as prompt-context.test.ts). */
function stubStore(
  main: { block: string; mdIds: string[]; signatures?: Signature[] },
  project?: { block: string; mdIds: string[]; signatures?: Signature[] },
): MemoryStore {
  return {
    getAssemblyManifest: () => ({ signatures: [], ...main }),
    getProjectAssemblyManifest: () =>
      project ? { signatures: [], ...project } : { block: "", mdIds: [], signatures: [] },
  } as unknown as MemoryStore;
}

/** Stub `pi` that records handlers per event and lets the test fire them. */
function stubPi(): { pi: any; fire: (ev: string, e: any, ctx?: any) => Promise<void> } {
  const handlers: Record<string, Array<(e: any, ctx?: any) => Promise<void> | void>> = {};
  const pi: any = {
    on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); },
    registerTool() {}, registerCommand() {},
  };
  const fire = async (ev: string, e: any, ctx?: any) => {
    for (const h of handlers[ev] ?? []) await h(e, ctx);
  };
  return { pi, fire };
}

describe("Task 6 — §5↔§9 join invariant (captureAssembly → surfaced set)", () => {
  it("surfaced-signature mdIds == the mdIds captureAssembly recorded (SAME receipt)", async () => {
    // Both surfaced entries carry qualifying signatures, so the surfaced set's
    // mdId set is EXACTLY the recorded mdId set.
    const store = stubStore({
      block: "M",
      mdIds: [MD_A, MD_B],
      signatures: [{ mdId: MD_A, signature: SIG_A }, { mdId: MD_B, signature: SIG_B }],
    });
    const records: RecordCall[] = [];
    let populated: Signature[] | null = null;
    const surfaced = new SurfacedSignatureSet();

    await captureAssembly({
      getSessionId: () => "sess-join",
      build: () => buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p"),
      record: (sid, mdIds, hash) => { records.push({ sid, mdIds: [...mdIds], hash }); return Promise.resolve(); },
      // Problem A: onReceipt populates the surfaced set from the SAME receipt.
      onReceipt: (r) => { populated = r.signatures; surfaced.populate(r.signatures); },
    });

    assert.strictEqual(records.length, 1);
    assert.ok(populated, "onReceipt fired with the receipt");
    // §5↔§9 join: recorded mdIds (session_assembly) == surfaced mdIds (matcher),
    // both from the SAME receipt.
    const recordedMdIds = records[0].mdIds.sort();
    const surfacedMdIds = populated.map((s) => s.mdId).sort();
    assert.deepEqual(surfacedMdIds, recordedMdIds);
    // And the REAL set, when probed, returns exactly those mdIds (populate wired).
    assert.deepEqual(
      surfaced.matchAndForget(normalizeForSignature(`${BODY_A} ${BODY_B}`)).sort(),
      recordedMdIds,
    );
  });

  it("onReceipt fires exactly once, AFTER record landed (no double build)", async () => {
    let buildCount = 0;
    let onReceiptCount = 0;
    const order: string[] = [];

    await captureAssembly({
      getSessionId: () => "sess-order",
      build: () => {
        buildCount++;
        return { mdIds: [MD_A], hash: "h".repeat(8), signatures: [{ mdId: MD_A, signature: SIG_A }] };
      },
      record: () => { order.push("record"); return Promise.resolve(); },
      onReceipt: () => { onReceiptCount++; order.push("onReceipt"); },
    });

    assert.strictEqual(buildCount, 1, "build called exactly once (no double-render)");
    assert.strictEqual(onReceiptCount, 1, "onReceipt called exactly once");
    // record BEFORE onReceipt — the surfaced set is populated only after the
    // session_assembly rows landed (keeps the §5↔§9 join exact even if record
    // threw it would be swallowed and onReceipt skipped).
    assert.deepEqual(order, ["record", "onReceipt"]);
  });

  it("null assembly (policy-only / empty store) → onReceipt NOT called", async () => {
    let onReceiptCount = 0;
    const landed = await captureAssembly({
      getSessionId: () => "sess-null",
      build: () => null, // policy-only / empty store
      record: () => { throw new Error("record must not be called"); },
      onReceipt: () => { onReceiptCount++; },
    });
    assert.strictEqual(landed, false);
    assert.strictEqual(onReceiptCount, 0);
  });

  it("missing sid → no build, no record, no onReceipt (once-per-session guard holds)", async () => {
    let buildCount = 0;
    let onReceiptCount = 0;
    const landed = await captureAssembly({
      getSessionId: () => undefined,
      build: () => { buildCount++; return { mdIds: [MD_A], hash: "h", signatures: [] }; },
      record: () => Promise.resolve(),
      onReceipt: () => { onReceiptCount++; },
    });
    assert.strictEqual(landed, false);
    assert.strictEqual(buildCount, 0);
    assert.strictEqual(onReceiptCount, 0);
  });
});

describe("Task 6 — disable path (usedDetection === false)", () => {
  it("session_start does NOT populate the set when usedDetection is disabled", async () => {
    // Mirrors index.ts wiring: onReceipt is passed ONLY when
    // config.usedDetection !== false. When disabled, onReceipt is undefined →
    // the set is never populated → matchAndForget always returns [] → markUsed
    // never fires.
    const config = { usedDetection: false } as any;
    const usePopulate = config.usedDetection !== false;
    const surfaced = new SurfacedSignatureSet();
    const store = stubStore({
      block: "M",
      mdIds: [MD_A],
      signatures: [{ mdId: MD_A, signature: SIG_A }],
    });

    await captureAssembly({
      getSessionId: () => "sess-disabled",
      build: () => buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p"),
      record: () => Promise.resolve(),
      onReceipt: usePopulate ? (r) => surfaced.populate(r.signatures) : undefined,
    });

    // Set was never populated → nothing matches → markUsed never called.
    assert.deepEqual(surfaced.matchAndForget(normalizeForSignature(BODY_A)), []);
  });

  it("default (usedDetection on): session_start DOES populate the set", async () => {
    const config = {} as any; // usedDetection unset → default on
    const usePopulate = config.usedDetection !== false;
    const surfaced = new SurfacedSignatureSet();
    const store = stubStore({
      block: "M",
      mdIds: [MD_A, MD_B],
      signatures: [{ mdId: MD_A, signature: SIG_A }, { mdId: MD_B, signature: SIG_B }],
    });

    await captureAssembly({
      getSessionId: () => "sess-enabled",
      build: () => buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p"),
      record: () => Promise.resolve(),
      onReceipt: usePopulate ? (r) => surfaced.populate(r.signatures) : undefined,
    });

    // Both signatures are live → both match.
    const matched = surfaced
      .matchAndForget(normalizeForSignature(`${BODY_A} ... ${BODY_B}`))
      .sort();
    assert.deepEqual(matched, [MD_A, MD_B]);
  });
});

describe("Task 6 — end-to-end smoke (capture → message_end → turn_end → markUsed)", () => {
  it("a populated set + assistant output containing a signature → markUsed(sid, [mdId])", async () => {
    const { pi, fire } = stubPi();
    const surfaced = new SurfacedSignatureSet();
    const calls: MarkUsedCall[] = [];
    const sessionRepo: any = {
      markUsed: async (sid: string, mdIds: readonly string[], usedAt: string) =>
        calls.push({ sid, mdIds: [...mdIds], usedAt }),
    };
    // Problem B: getSessionId is a holder bound at setup time, read at turn_end.
    let activeSessionId: string | undefined;
    setupUsedDetection(pi, sessionRepo, surfaced, {} as any, () => activeSessionId ?? null);

    // session_start: record the assembly + populate the surfaced set from the
    // SAME receipt (the §5↔§9 join). One build, consumed by both sides.
    activeSessionId = "sess-e2e";
    const store = stubStore({
      block: "M",
      mdIds: [MD_A],
      signatures: [{ mdId: MD_A, signature: SIG_A }],
    });
    await captureAssembly({
      getSessionId: () => activeSessionId,
      build: () => buildPromptAssembly({ memoryMode: "default" } as any, store, null, "p"),
      record: () => Promise.resolve(),
      onReceipt: (r) => surfaced.populate(r.signatures),
    });

    // Assistant references the surfaced memory in its output.
    await fire("message_end", { message: { role: "assistant", content: `Sure — ${BODY_A} on load.` } });
    await fire("turn_end", {}, {});

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].sid, "sess-e2e");
    assert.deepEqual(calls[0].mdIds, [MD_A]);
    assert.ok(!Number.isNaN(Date.parse(calls[0].usedAt)), "usedAt is a valid ISO timestamp");
  });

  it("a populated set + assistant output WITHOUT any signature → markUsed NOT called (set intact)", async () => {
    const { pi, fire } = stubPi();
    const surfaced = new SurfacedSignatureSet();
    const calls: MarkUsedCall[] = [];
    const sessionRepo: any = {
      markUsed: async (sid: string, mdIds: readonly string[], usedAt: string) =>
        calls.push({ sid, mdIds: [...mdIds], usedAt }),
    };
    let activeSessionId: string | undefined = "sess-e2e-nomatch";
    setupUsedDetection(pi, sessionRepo, surfaced, {} as any, () => activeSessionId ?? null);
    surfaced.populate([{ mdId: MD_A, signature: SIG_A }]);

    await fire("message_end", { message: { role: "assistant", content: "Hello! How can I help today?" } });
    await fire("turn_end", {}, {});

    assert.strictEqual(calls.length, 0);
    // signature still live for a later turn
    assert.deepEqual(surfaced.matchAndForget(normalizeForSignature(BODY_A)), [MD_A]);
  });

  it("monotonic across turns: referenced once → markUsed once; never re-marked", async () => {
    const { pi, fire } = stubPi();
    const surfaced = new SurfacedSignatureSet();
    const calls: MarkUsedCall[] = [];
    const sessionRepo: any = {
      markUsed: async (sid: string, mdIds: readonly string[], usedAt: string) =>
        calls.push({ sid, mdIds: [...mdIds], usedAt }),
    };
    let activeSessionId: string | undefined = "sess-mono";
    setupUsedDetection(pi, sessionRepo, surfaced, {} as any, () => activeSessionId ?? null);
    surfaced.populate([{ mdId: MD_A, signature: SIG_A }]);

    // turn 1 — referenced
    await fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await fire("turn_end", {}, {});
    assert.strictEqual(calls.length, 1);

    // turn 2 — same text again, but signature already forgotten → no re-mark
    await fire("message_end", { message: { role: "assistant", content: BODY_A } });
    await fire("turn_end", {}, {});
    assert.strictEqual(calls.length, 1);
  });
});
