/**
 * Tests for the opt-in model-visible pathology note (ticket 04, D2).
 *
 * Pins the two Done-when contracts: with `BUN_PI_PATHOLOGY_INJECT=1` a
 * retry-loop episode produces exactly ONE model-visible note, delivered once at
 * the turn boundary; with the env unset there is ZERO model-visible output (the
 * documented non-invasive default holds). Also pins per-session keying (an
 * in-process subagent child consumes its own note) and the factory wiring
 * receipt — the captured before_agent_start handler returns the CustomMessage
 * shape the SDK injects (faux-transport receipt, no live session needed).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  injectionEnabled,
  noteText,
  makeInjectionHooks,
  takePendingNote,
  resetInjection,
} from "../inject.ts";
import { makeWarner, resetWarning } from "../warning.ts";
import type { Finding } from "../../findings.ts";
import type { ToolCallRecord } from "../types.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const ENV = "BUN_PI_PATHOLOGY_INJECT";

function rec(toolName: string, argsSig: string, isError = false): ToolCallRecord {
  return { toolName, argsSig, isError, ts: 0 };
}

/** A 3-call identical run → active retry-loop episode. */
function loopOf(n = 3): ToolCallRecord[] {
  return Array.from({ length: n }, () => rec("bash", '{"command":"npm test"}'));
}

function loopFinding(count: number): Finding {
  return {
    severity: "high",
    check: "retry-loop",
    message: "m",
    detail: { tool: "bash", count },
  };
}

/** Per-sid persistent episode maps — mirrors the module singleton across evaluations. */
const episodeSets = new Map<string, Set<string>>();

/** Warner that drives the REAL hook wiring (injection hooks + episode map) for a sid. */
function warnSession(calls: ToolCallRecord[], sid?: string) {
  const key = sid ?? "";
  let warned = episodeSets.get(key);
  if (!warned) {
    warned = new Set();
    episodeSets.set(key, warned);
  }
  const hooks = makeInjectionHooks(sid);
  return makeWarner({ setStatus: () => {} }, warned, { sid, hooks })(calls);
}

beforeEach(() => {
  resetInjection();
  resetWarning();
  episodeSets.clear();
});

afterEach(() => {
  delete process.env[ENV];
});

// ─── env gate ─────────────────────────────────────────────────────────────────

describe("injectionEnabled", () => {
  test("default OFF — env unset is not enabled", () => {
    delete process.env[ENV];
    expect(injectionEnabled()).toBe(false);
  });

  test("opt-in — exactly BUN_PI_PATHOLOGY_INJECT=1 enables", () => {
    process.env[ENV] = "1";
    expect(injectionEnabled()).toBe(true);
    process.env[ENV] = "true";
    expect(injectionEnabled()).toBe(false);
  });
});

// ─── env unset → zero model-visible output (Done-when #2) ─────────────────────

describe("env unset: no injection ever", () => {
  test("an active retry-loop episode arms NOTHING — takePendingNote stays undefined", () => {
    delete process.env[ENV];
    warnSession(loopOf(3));
    warnSession(loopOf(8));
    expect(takePendingNote()).toBeUndefined();
  });
});

// ─── env set → exactly one note per episode at the boundary (Done-when #1) ────

describe("env set: once-per-episode note", () => {
  test("active episode arms one note; the take is destructive (once per boundary)", () => {
    process.env[ENV] = "1";
    const worst = warnSession(loopOf(3));
    expect(worst?.check).toBe("retry-loop");
    const note = takePendingNote();
    expect(note).toBeTruthy();
    expect(note).toContain("bash");
    expect(note).toContain("inspect_pathology");
    expect(takePendingNote()).toBeUndefined(); // consumed — no double-inject
  });

  test("cadence: repeated evaluations within ONE episode keep a single pending note", () => {
    process.env[ENV] = "1";
    warnSession(loopOf(3));
    warnSession(loopOf(4));
    warnSession(loopOf(9));
    const notes = [takePendingNote(), takePendingNote(), takePendingNote()].filter(Boolean);
    expect(notes.length).toBe(1);
  });

  test("episode end drops the pending note; a fresh episode re-arms", () => {
    process.env[ENV] = "1";
    warnSession(loopOf(3));
    warnSession([rec("read", '{"path":"a"}')]); // episode ends before delivery
    expect(takePendingNote()).toBeUndefined();
    warnSession(loopOf(4)); // fresh episode
    const note = takePendingNote();
    expect(note).toContain("4×");
  });
});

// ─── per-session keying (Done-when #3 half) ───────────────────────────────────

describe("per-session isolation", () => {
  test("a child boundary consumes only the child's note; the parent's stays armed", () => {
    process.env[ENV] = "1";
    warnSession(loopOf(3), "sid-parent");
    warnSession(loopOf(3), "sid-child");
    const childNote = takePendingNote("sid-child");
    expect(childNote).toBeTruthy();
    expect(takePendingNote("sid-child")).toBeUndefined(); // consumed
    // The child's turn boundary did NOT touch the parent's pending note.
    const parentNote = takePendingNote("sid-parent");
    expect(parentNote).toBeTruthy();
    expect(takePendingNote("sid-parent")).toBeUndefined();
  });
});

// ─── note text ────────────────────────────────────────────────────────────────

describe("noteText", () => {
  test("retry-loop phrasing names the tool, magnitude, and the escape hatch", () => {
    const t = noteText(loopFinding(4));
    expect(t.startsWith("system note: bash called 4× with identical args")).toBe(true);
    expect(t).toContain("inspect_pathology");
  });

  test("consecutive-error phrasing switches to failed-N×", () => {
    const f: Finding = { severity: "high", check: "consecutive-error", message: "m", detail: { tool: "read", consecutive: 5 } };
    expect(noteText(f)).toContain("read failed 5× consecutively");
  });
});

// ─── factory wiring receipt (faux transport) ──────────────────────────────────

describe("factory wiring", () => {
  test("before_agent_start returns the pending note as a CustomMessage; unset env → no-op", async () => {
    process.env[ENV] = "1";
    const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
    const mockPi: any = {
      registerTool: () => {},
      on: (event: string, handler: any) => { handlers.set(event, handler); },
      registerCommand: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      getCommands: () => [],
    };
    const factory = (await import("../../index.ts")).default as ExtensionFactory;
    factory(mockPi);

    const sid = "sid-factory";
    const toolCtx = { sessionManager: { getSessionId: () => sid } };
    // Simulate the episode: 3 identical tool_execution_end evaluations.
    const endHandler = handlers.get("tool_execution_end")!;
    for (let i = 0; i < 3; i++) {
      endHandler(
        { toolCallId: `tc-${i}`, toolName: "bash", result: {}, isError: false },
        { ...toolCtx, ui: {} },
      );
    }
    // Turn boundary: the before_agent_start handler must return the note ONCE.
    const boundary = handlers.get("before_agent_start")!;
    const result = (await boundary({}, toolCtx)) as
      | { message: { customType: string; content: string; display: boolean } }
      | undefined;
    expect(result?.message.customType).toBe("pathology-note");
    expect(result?.message.display).toBe(true);
    expect(result?.message.content).toContain("bash");
    expect(result?.message.content).toContain("inspect_pathology");
    // Second boundary: consumed — no further injection.
    expect(await boundary({}, toolCtx)).toBeUndefined();
  });

  test("env unset through the FULL factory path: no note at the boundary", async () => {
    delete process.env[ENV];
    const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
    const mockPi: any = {
      registerTool: () => {},
      on: (event: string, handler: any) => { handlers.set(event, handler); },
      registerCommand: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
      getCommands: () => [],
    };
    const factory = (await import("../../index.ts")).default as ExtensionFactory;
    factory(mockPi);

    const sid = "sid-factory-off";
    const toolCtx = { sessionManager: { getSessionId: () => sid } };
    const endHandler = handlers.get("tool_execution_end")!;
    for (let i = 0; i < 3; i++) {
      endHandler({ toolCallId: `tc-${i}`, toolName: "bash", result: {}, isError: false }, { ...toolCtx, ui: {} });
    }
    const boundary = handlers.get("before_agent_start")!;
    expect(await boundary({}, toolCtx)).toBeUndefined();
  });
});
