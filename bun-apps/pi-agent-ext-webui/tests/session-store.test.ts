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

  it("cards-ux2 (04a): card / card_done frames are exempt from eviction", () => {
    const s = createSessionStore(5); // tiny cap so eviction actually fires
    // cards EARLY, generic frames after (a plain FIFO would drop both cards)
    s.append({
      type: "card",
      id: "c1",
      kind: "readonly",
      title: "Draft",
      source: "test",
      ts: 1,
      attention: "view",
      body: { text: "q" },
    });
    s.append({ type: "message_update", text: "1" });
    s.append({ type: "message_update", text: "2" });
    s.append({
      type: "card_done",
      id: "c1",
      ts: 2,
      answers: [{ label: "L", answer: "a" }],
    });
    for (const t of ["3", "4", "5", "6", "7", "8"]) {
      s.append({ type: "message_update", text: t });
    }
    const snap = s.snapshot();
    expect(snap.transcript.length).toBeLessThanOrEqual(5);
    const types = snap.transcript.map((f) => f.type);
    const cardIdx = types.indexOf("card");
    const doneIdx = types.indexOf("card_done");
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(cardIdx).toBeLessThan(doneIdx); // replay order preserved
    // 10 appended, cap 5 → both cards + the 3 newest messages survive
    expect(types).toEqual([
      "card",
      "card_done",
      "message_update",
      "message_update",
      "message_update",
    ]);
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
