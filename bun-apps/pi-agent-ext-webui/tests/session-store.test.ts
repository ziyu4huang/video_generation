/**
 * session-store.test.ts — the v2 client-visible session state
 * (architecture v2 §3.3).
 */
import { describe, expect, it } from "bun:test";
import { createSessionStore, TRANSCRIPT_CAP } from "../src/session-store.js";

describe("createSessionStore", () => {
  it("accumulates frames in order and returns a bounded transcript", () => {
    const s = createSessionStore(3); // tiny cap for the bound test
    s.append({ type: "turn_start" });
    s.append({ type: "message_update", text: "a" });
    s.append({ type: "message_update", text: "b" });
    s.append({ type: "message_update", text: "c" });
    const snap = s.snapshot();
    expect(snap.transcript.map((f) => f.type)).toEqual([
      "message_update",
      "message_update",
      "message_update",
    ]);
    expect(snap.transcript[0]).toMatchObject({ text: "a" });
  });

  it("the default cap is TRANSCRIPT_CAP", () => {
    const s = createSessionStore();
    for (let i = 0; i < TRANSCRIPT_CAP + 50; i++) {
      s.append({ type: "message_update", text: String(i) });
    }
    expect(s.snapshot().transcript).toHaveLength(TRANSCRIPT_CAP);
  });

  it("tracks the mutex driver from mutex_blocked; clears on settle / force-release", () => {
    const s = createSessionStore();
    expect(s.snapshot().driver).toBeNull();
    s.append({ type: "mutex_blocked", blocked: "tui", by: "web" });
    expect(s.snapshot().driver).toBe("web");
    s.append({ type: "agent_settled" });
    expect(s.snapshot().driver).toBeNull();
    s.append({ type: "mutex_blocked", blocked: "web", by: "tui" });
    expect(s.snapshot().driver).toBe("tui");
    s.append({ type: "mutex_force_release", driver: "tui" });
    expect(s.snapshot().driver).toBeNull();
  });

  it("setPresentId drives the snapshot presentId", () => {
    const s = createSessionStore();
    expect(s.snapshot().presentId).toBeNull();
    s.setPresentId("present_1");
    expect(s.snapshot().presentId).toBe("present_1");
    s.setPresentId(null);
    expect(s.snapshot().presentId).toBeNull();
  });

  it("clear() resets transcript / present / driver (session_shutdown)", () => {
    const s = createSessionStore();
    s.append({ type: "turn_start" });
    s.append({ type: "mutex_blocked", blocked: "tui", by: "web" });
    s.setPresentId("p1");
    s.clear();
    const snap = s.snapshot();
    expect(snap.transcript).toEqual([]);
    expect(snap.presentId).toBeNull();
    expect(snap.driver).toBeNull();
  });

  it("snapshot returns a COPY — mutating it does not affect the store", () => {
    const s = createSessionStore();
    s.append({ type: "turn_start" });
    const snap = s.snapshot();
    snap.transcript.push({ type: "agent_settled" });
    snap.presentId = "x";
    expect(s.snapshot().transcript).toHaveLength(1);
    expect(s.snapshot().presentId).toBeNull();
  });
});
