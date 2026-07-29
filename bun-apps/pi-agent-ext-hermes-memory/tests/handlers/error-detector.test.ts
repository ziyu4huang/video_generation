/**
 * Tests for the lesson-worthy error detector (Stage 1: auto-trigger).
 *
 * Covers the two gates that make auto-capture safe:
 *   1. SEVERITY — only lesson-worthy errors (stack traces, definitive failures)
 *      are captured; trivial noise (grep no-match, exploratory path-not-found)
 *      is suppressed.
 *   2. DEDUP — a repeated error does not spawn N duplicate rows.
 */
import { describe, it, beforeEach, afterEach } from "bun:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import { isLessonWorthy, errorSignature, errorDedupKey, setupErrorDetector } from "../../src/handlers/error-detector.js";
import type { MemoryConfig } from "../../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "error-detector-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("isLessonWorthy — severity gate", () => {
  it("captures stack traces", () => {
    assert.equal(isLessonWorthy("Traceback (most recent call last):\n  File \"app.py\", line 10"), true);
    assert.equal(isLessonWorthy("TypeError: Cannot read properties of undefined\n    at Object.<anonymous> (file.ts:42:5)"), true);
  });

  it("captures definitive system/module errors", () => {
    assert.equal(isLessonWorthy("Error: ENOENT: no such file or directory, open '/x/y'"), true);
    assert.equal(isLessonWorthy("Error: listen EADDRINUSE: address already in use"), true);
    assert.equal(isLessonWorthy("ModuleNotFoundError: No module named 'mlx'"), true);
    assert.equal(isLessonWorthy("zsh: command not found: ripgrep"), true);
    assert.equal(isLessonWorthy("Cannot find module 'better-sqlite3'"), true);
    assert.equal(isLessonWorthy("fatal: not a git repository"), true);
  });

  it("captures test/build failures", () => {
    assert.equal(isLessonWorthy("3 failed, 12 passed"), true);
    assert.equal(isLessonWorthy("BUILD FAILED"), true);
  });

  it("does NOT capture trivial noise", () => {
    assert.equal(isLessonWorthy("No matches found"), false);
    assert.equal(isLessonWorthy("Path not found: /some/exploratory/path"), false);
    assert.equal(isLessonWorthy("Operation aborted"), false);
  });

  it("does NOT capture a bare non-descriptive exit", () => {
    // A bare stderr with no lesson-worthy marker is NOT captured — this is the
    // "not every non-zero exit" gate.
    assert.equal(isLessonWorthy("some output\nexit code 1"), false);
  });
});

describe("errorSignature — dedup key", () => {
  it("is stable across path/count variation (same error → same signature)", () => {
    const a = errorSignature("bash", "Error: ENOENT: no such file or directory, open '/home/user/proj/file.txt'");
    const b = errorSignature("bash", "Error: ENOENT: no such file or directory, open '/etc/other/place.json'");
    assert.equal(a, b, "different paths → same normalised signature");
  });

  it("distinguishes different error classes", () => {
    const a = errorSignature("bash", "Error: ENOENT: no such file");
    const b = errorSignature("bash", "Error: EADDRINUSE: address in use");
    assert.notEqual(a, b);
  });

  it("includes the toolName", () => {
    const sig = errorSignature("edit", "fatal: not a git repository");
    assert.ok(sig.startsWith("edit:"));
  });
});

describe("setupErrorDetector — dedup against the store (criterion 2)", () => {
  // Use the real MemoryStore + addFailure to prove a repeated error does not
  // spawn duplicate rows. We exercise the dedup KEY logic against the store
  // directly (the hook itself is wired in index.ts; the dedup decision is the
  // part that must be correct).
  it("the same error signature matches an already-stored failure entry", async () => {
    const store = new MemoryStore({ memoryDir: tmpDir });
    await store.addFailure("[bash error] Error: ENOENT: no such file or directory, open '/a/b'", {
      category: "failure",
    });
    const existing = store.getFailureEntries(30);
    const newKey = errorDedupKey("Error: ENOENT: no such file or directory, open '/x/y'");
    // The dedup check normalises existing entries with the SAME function; the
    // two ENOENT errors must collapse to the same key → dedup fires.
    assert.ok(
      existing.some((e) => errorDedupKey(e) === newKey),
      "a re-occurrence of the same error must match the stored entry → dedup fires",
    );
  });

  it("a different error does NOT match an existing entry", async () => {
    const store = new MemoryStore({ memoryDir: tmpDir });
    await store.addFailure("[bash error] Error: EADDRINUSE: address already in use", {
      category: "failure",
    });
    const existing = store.getFailureEntries(30);
    const newKey = errorDedupKey("Error: ENOENT: no such file or directory");
    assert.ok(
      !existing.some((e) => errorDedupKey(e) === newKey),
      "a genuinely different error must not be deduped away",
    );
  });
});

function createMockPi(handlers: Record<string, Function[]>) {
  return {
    on: (event: string, handler: Function) => { (handlers[event] ||= []).push(handler); },
    registerTool: () => {},
    registerCommand: () => {},
  } as any;
}

function makeToolResultEvent(toolName: string, text: string, isError = true) {
  return { toolName, isError, content: [{ type: "text", text }] };
}

const LESSON_WORTHY_ENOENT = "Error: ENOENT: no such file or directory, open '/x/y'";
const LESSON_WORTHY_EADDR = "Error: listen EADDRINUSE: address already in use";

describe("setupErrorDetector — per-session throttle (#854)", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "errcap-throttle-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** Wire a fresh detector + store; return a fire() helper and a row counter. */
  function wire(configOverrides: Partial<MemoryConfig> = {}, seededStore?: MemoryStore) {
    const handlers: Record<string, Function[]> = {};
    const pi = createMockPi(handlers);
    const store = seededStore ?? new MemoryStore({ memoryDir: tmpDir });
    const config = { errorCapture: true, ...configOverrides } as MemoryConfig;
    setupErrorDetector(pi, store, null, config, null, undefined);
    const fire = async (text: string, isError = true) => {
      for (const fn of handlers["tool_result"] ?? []) {
        await fn(makeToolResultEvent("bash", text, isError), { ui: { notify() {} } });
      }
    };
    return { fire, store };
  }

  it("rate-caps repeated DISTINCT errors at errorCaptureRateLimit", async () => {
    const { fire, store } = wire({ errorCaptureRateLimit: 2, errorCaptureRateWindowMs: 600_000, errorCaptureDedupCacheSize: 64 });
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_EADDR);
    await fire("ModuleNotFoundError: No module named 'pkg-three'");
    assert.equal(store.getFailureEntries(100).length, 2, "third distinct error is rate-capped");
  });

  it("the same error twice → one row (dedup)", async () => {
    const { fire, store } = wire({ errorCaptureRateLimit: 5 });
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_ENOENT);
    assert.equal(store.getFailureEntries(100).length, 1);
  });

  it("cross-session store-dup does NOT consume a rate slot", async () => {
    // Pre-seed the store so the store-check (②) catches the ENOENT occurrence.
    const seeded = new MemoryStore({ memoryDir: tmpDir });
    await seeded.addFailure(`[bash error] ${LESSON_WORTHY_ENOENT}`, { category: "failure" });
    const { fire, store } = wire({ errorCaptureRateLimit: 1 }, seeded);

    // Fire the already-stored error 3× — all caught by ②, no write, no recordCapture.
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_ENOENT);
    // A genuinely NOVEL error must STILL be captured (rate slot not eaten by the dups).
    await fire(LESSON_WORTHY_EADDR);
    assert.equal(store.getFailureEntries(100).length, 2, "novel error still captured despite prior store-dup attempts");
  });

  it("non-error tool result is ignored", async () => {
    const { fire, store } = wire({ errorCaptureRateLimit: 5 });
    await fire(LESSON_WORTHY_ENOENT, false); // isError=false
    assert.equal(store.getFailureEntries(100).length, 0);
  });
});
