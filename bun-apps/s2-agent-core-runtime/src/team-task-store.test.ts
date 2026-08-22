/**
 * TeamTaskStore (agent-teams parity ticket 03,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the board contract: CRUD over a session-scoped in-memory store,
 * symmetric blocks/blockedBy edges, cycle rejection (direct + transitive),
 * owner claim validation, per-session isolation, and reset/drop semantics.
 * All against a fresh store instance per test — the singleton path is covered
 * by the getTeamTaskStore identity assertions at the bottom.
 */
import { describe, expect, test } from "bun:test";
import {
  __resetTeamTaskStoreForTests,
  getTeamTaskStore,
  isTeamTaskError,
  type TeamTask,
  TeamTaskStore,
} from "./team-task-store.js";

function ok<T>(v: T | { error: string }): T {
  if (isTeamTaskError(v)) throw new Error(`unexpected error: ${v.error}`);
  return v as T;
}

function mk(): TeamTaskStore {
  return new TeamTaskStore();
}

describe("TeamTaskStore — create/get/list", () => {
  test("creates pending tasks with monotonic per-board ids", () => {
    const s = mk();
    const a = ok(s.create("*", { subject: "wire the board" }));
    const b = ok(s.create("*", { subject: "second", description: "d", activeForm: "Doing second", owner: "main" }));
    expect(a.id).toBe("1");
    expect(b.id).toBe("2");
    expect(a.status).toBe("pending");
    expect(a.description).toBe("");
    expect(a.blocks).toEqual([]);
    expect(a.blockedBy).toEqual([]);
    expect(b.activeForm).toBe("Doing second");
    expect(b.owner).toBe("main");
    expect(s.get("*", "1")).toBe(a);
    expect(s.list("*")).toEqual([a, b]);
  });

  test("rejects empty subject and empty-string owner", () => {
    const s = mk();
    expect(isTeamTaskError(s.create("*", { subject: "   " }))).toBe(true);
    expect(isTeamTaskError(s.create("*", { subject: "x", owner: "" }))).toBe(true);
  });

  test("create with edges links symmetric inverse lists", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    ok(s.create("*", { subject: "b", blockedBy: ["1"] }));
    const a = s.get("*", "1") as TeamTask;
    const b = s.get("*", "2") as TeamTask;
    expect(b.blockedBy).toEqual(["1"]);
    expect(a.blocks).toEqual(["2"]);
  });

  test("create with an unknown edge id unwinds the task entirely (id reused)", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    const err = s.create("*", { subject: "b", blockedBy: ["9"] });
    expect(isTeamTaskError(err)).toBe(true);
    expect(s.list("*").length).toBe(1);
    // The unborn task's id is not burned: the next create reuses "2".
    expect(ok(s.create("*", { subject: "c" })).id).toBe("2");
  });

  test("get on an unknown board returns undefined; list returns []", () => {
    const s = mk();
    expect(s.get("nope", "1")).toBeUndefined();
    expect(s.list("nope")).toEqual([]);
  });
});

describe("TeamTaskStore — dependency edges", () => {
  test("direct self-dependency rejected", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    expect(isTeamTaskError(s.update("*", "1", { addBlockedBy: ["1"] }))).toBe(true);
  });

  test("two-task cycle rejected via update", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    ok(s.create("*", { subject: "b", blockedBy: ["1"] }));
    // b already depends on a; making a depend on b closes the cycle.
    const err = s.update("*", "1", { addBlockedBy: ["2"] });
    expect(isTeamTaskError(err)).toBe(true);
    expect((s.get("*", "1") as TeamTask).blockedBy).toEqual([]);
  });

  test("transitive (3-hop) cycle rejected", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    ok(s.create("*", { subject: "b", blockedBy: ["1"] }));
    ok(s.create("*", { subject: "c", blockedBy: ["2"] }));
    // c→b→a already; a blockedBy c closes a 3-cycle.
    expect(isTeamTaskError(s.update("*", "1", { addBlockedBy: ["3"] }))).toBe(true);
  });

  test("cycle rejected through addBlocks (the symmetric side)", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    ok(s.create("*", { subject: "b", blockedBy: ["1"] }));
    // "a blocks b" is already linked (idempotent no-op); "b blocks a" would close the cycle.
    const idempotent = s.update("*", "1", { addBlocks: ["2"] });
    expect(isTeamTaskError(idempotent)).toBe(false);
    expect(isTeamTaskError(s.update("*", "2", { addBlocks: ["1"] }))).toBe(true);
  });

  test("removeBlockedBy / removeBlocks unlink BOTH sides; unknown removal is a no-op", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    ok(s.create("*", { subject: "b", blockedBy: ["1"] }));
    ok(s.update("*", "2", { removeBlockedBy: ["1"] }));
    expect((s.get("*", "1") as TeamTask).blocks).toEqual([]);
    expect((s.get("*", "2") as TeamTask).blockedBy).toEqual([]);
    // Removing through the other side also cleans both.
    ok(s.update("*", "2", { addBlockedBy: ["1"] }));
    ok(s.update("*", "1", { removeBlocks: ["2"] }));
    expect((s.get("*", "2") as TeamTask).blockedBy).toEqual([]);
    ok(s.update("*", "2", { removeBlockedBy: ["404"] })); // no-op, not an error
  });

  test("update with an unknown edge target errors and adds nothing", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    expect(isTeamTaskError(s.update("*", "1", { addBlockedBy: ["9"] }))).toBe(true);
    expect((s.get("*", "1") as TeamTask).blockedBy).toEqual([]);
  });
});

describe("TeamTaskStore — update semantics", () => {
  test("patch fields: subject/description/activeForm/status/metadata + null clears optionals", () => {
    const s = mk();
    const t = ok(s.create("*", { subject: "a", activeForm: "Doing a" }));
    ok(s.update("*", t.id, { status: "in_progress", metadata: { pr: 1818 } }));
    let cur = s.get("*", t.id) as TeamTask;
    expect(cur.status).toBe("in_progress");
    expect(cur.metadata).toEqual({ pr: 1818 });
    ok(s.update("*", t.id, { activeForm: null, subject: "a2", description: "d2" }));
    cur = s.get("*", t.id) as TeamTask;
    expect(cur.activeForm).toBeUndefined();
    expect(cur.subject).toBe("a2");
    expect(cur.description).toBe("d2");
    expect(cur.updatedAt).toBeGreaterThanOrEqual(cur.createdAt);
  });

  test("owner claim / re-claim / release(null); empty string rejected", () => {
    const s = mk();
    const t = ok(s.create("*", { subject: "a" }));
    ok(s.update("*", t.id, { owner: "researcher" }));
    expect((s.get("*", t.id) as TeamTask).owner).toBe("researcher");
    ok(s.update("*", t.id, { owner: "main" }));
    expect((s.get("*", t.id) as TeamTask).owner).toBe("main");
    ok(s.update("*", t.id, { owner: null }));
    expect((s.get("*", t.id) as TeamTask).owner).toBeUndefined();
    expect(isTeamTaskError(s.update("*", t.id, { owner: "  " }))).toBe(true);
  });

  test("emptying subject rejected; unknown task id rejected", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    expect(isTeamTaskError(s.update("*", "1", { subject: " " }))).toBe(true);
    expect(isTeamTaskError(s.update("*", "404", { status: "completed" }))).toBe(true);
  });
});

describe("TeamTaskStore — session scoping + lifecycle", () => {
  test("boards are isolated per sessionId", () => {
    const s = mk();
    ok(s.create("s1", { subject: "one" }));
    ok(s.create("s2", { subject: "two" }));
    expect(s.list("s1").length).toBe(1);
    expect(s.list("s2").length).toBe(1);
    expect(s.get("s1", "2")).toBeUndefined(); // "2" exists only on s2
  });

  test("reset empties one board (session_start)", () => {
    const s = mk();
    ok(s.create("s1", { subject: "one" }));
    ok(s.create("s2", { subject: "two" }));
    s.reset("s1");
    expect(s.list("s1")).toEqual([]);
    expect(s.list("s2").length).toBe(1);
  });

  test("drop removes the board; '*' drops every board (session_shutdown)", () => {
    const s = mk();
    ok(s.create("s1", { subject: "one" }));
    ok(s.create("s2", { subject: "two" }));
    expect(s.drop("s1")).toBe(1);
    expect(s.list("s1")).toEqual([]);
    expect(s.size).toBe(1);
    ok(s.create("s2", { subject: "three" }));
    expect(s.drop("*")).toBeGreaterThanOrEqual(1);
    expect(s.size).toBe(0);
  });

  test("ids restart on a reset board", () => {
    const s = mk();
    ok(s.create("*", { subject: "a" }));
    s.reset("*");
    expect(ok(s.create("*", { subject: "b" })).id).toBe("1");
  });
});

describe("getTeamTaskStore — process singleton", () => {
  test("one instance per process; reset hook re-arms it", () => {
    __resetTeamTaskStoreForTests();
    const a = getTeamTaskStore();
    const b = getTeamTaskStore();
    expect(a).toBe(b);
    __resetTeamTaskStoreForTests();
    expect(getTeamTaskStore()).not.toBe(a);
    __resetTeamTaskStoreForTests(); // leave a clean singleton for other tests
  });
});
