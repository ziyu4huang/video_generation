/**
 * Task 6 — per-session prompt-provenance capture (UPSP §5).
 *
 * The once-per-session capture at `session_start` is wired via the extracted
 * pure helper `captureAssembly` (src/handlers/session-assembly.ts) — the same
 * pattern the codebase uses for scheduleSessionBackfill / scheduleLiveSessionIndex.
 * Driving the extension's default export for a full pi `session_start` event is
 * awkward (heavy startup side effects: backend init, .md→db sync, migrations),
 * and the brief explicitly allows the extracted-helper route. So this file
 * unit-tests the helper with stubs, asserting the four contracts the handler
 * depends on:
 *
 *   • RECORD-ONCE  — sid + non-empty assembly ⇒ record called once with the
 *                    sid, the md_ids, and a string hash.
 *   • NULL-SID     — no session id ⇒ record never called.
 *   • POLICY-ONLY  — build() returns null (policy-only / empty store) ⇒ record
 *                    never called.
 *   • NEVER-ABORT  — a throwing record() is swallowed; captureAssembly resolves
 *                    (the session_start handler never throws).
 */
import { describe, test, expect, mock } from "bun:test";

import { captureAssembly } from "../../src/handlers/session-assembly.js";

describe("session_start assembly capture (captureAssembly)", () => {
  test("records manifest once with the sid, non-empty mdIds, and a string hash", async () => {
    const recordAssembly = mock(() => Promise.resolve());
    const mdIds = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];

    const landed = await captureAssembly({
      getSessionId: () => "sess-x",
      build: () => ({ mdIds, hash: "deadbeef".repeat(8) }),
      record: recordAssembly,
    });

    expect(landed).toBe(true);
    expect(recordAssembly).toHaveBeenCalledTimes(1);
    const [sid, recordedMdIds, hash] = recordAssembly.mock.calls[0]!;
    expect(sid).toBe("sess-x");
    expect(recordedMdIds.length).toBeGreaterThan(0);
    expect(recordedMdIds).toEqual(mdIds);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("a throwing record() does not abort — captureAssembly resolves (never block startup)", async () => {
    const recordAssembly = mock(() => Promise.reject(new Error("boom")));

    // Must NOT throw — the session_start handler stays best-effort.
    const landed = await captureAssembly({
      getSessionId: () => "sess-x",
      build: () => ({ mdIds: ["id-1"], hash: "abc123" }),
      record: recordAssembly,
    });

    expect(recordAssembly).toHaveBeenCalledTimes(1);
    expect(landed).toBe(false); // record did not land (it threw, swallowed)
  });

  test("a missing session id skips the record entirely (once-per-session guard)", async () => {
    const recordAssembly = mock(() => Promise.resolve());

    const landed = await captureAssembly({
      getSessionId: () => undefined,
      build: () => ({ mdIds: ["id-1"], hash: "abc123" }),
      record: recordAssembly,
    });

    expect(landed).toBe(false);
    expect(recordAssembly).not.toHaveBeenCalled();
  });

  test("policy-only / empty store (build returns null) writes nothing", async () => {
    const recordAssembly = mock(() => Promise.resolve());

    const landed = await captureAssembly({
      getSessionId: () => "sess-x",
      build: () => null,
      record: recordAssembly,
    });

    expect(landed).toBe(false);
    expect(recordAssembly).not.toHaveBeenCalled();
  });

  test("an empty-string session id is treated as missing (no record)", async () => {
    const recordAssembly = mock(() => Promise.resolve());

    const landed = await captureAssembly({
      getSessionId: () => "",
      build: () => ({ mdIds: ["id-1"], hash: "abc123" }),
      record: recordAssembly,
    });

    expect(landed).toBe(false);
    expect(recordAssembly).not.toHaveBeenCalled();
  });

  test("a throwing build() is also swallowed (never block startup)", async () => {
    const recordAssembly = mock(() => Promise.resolve());

    const landed = await captureAssembly({
      getSessionId: () => "sess-x",
      build: () => { throw new Error("build boom"); },
      record: recordAssembly,
    });

    expect(recordAssembly).not.toHaveBeenCalled();
    expect(landed).toBe(false);
  });
});
