/**
 * Cross-package integration test: the REAL `pi-agent-ext-wayfind` producer
 * driving the REAL `pi-agent-ext-planning-with-files` consumer.
 *
 * The seam contract has two halves that must hold against each other's ACTUAL
 * implementation (not stubs):
 *
 *   1. Coordination seam (turn-ownership):
 *        wayfind publishes `globalThis.__piWayfindActive = () => liveState`
 *        planning reads it via `isExternalDriverActive()` and YIELDS (skips
 *        plan injection + auto-continue) while a grill is active.
 *
 *   2. Content handoff (grill → plan):
 *        wayfind's `buildPlanSeed()` emits a planning-with-files-shaped
 *        `task_plan.md`; planning's `readPlanStatus()` must parse it and report
 *        `isPlanIncomplete = true` (ready for `/plan-execute`).
 *
 * Why this file is separate from coordination.test.ts: that one stubs
 * `globalThis.__piWayfindActive` to unit-test planning's READER in isolation
 * (and guards the standalone/degrade path). THIS file imports wayfind's real
 * exports to prove the live contract holds end-to-end. If wayfind renames its
 * key constant or reshapes buildPlanSeed, the stub tests stay green but THIS
 * test fails — catching the drift before it reaches a user.
 *
 * Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bun test )`
 * No RUN_E2E gate — this is a hermetic, fast, no-model unit-level integration
 * (imports sibling TS directly, like the rest of tests/).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── REAL wayfind producer exports (relative import, like within-package tests) ──
import {
  buildPlanSeed,
  createRuntimeState,
  publishWayfindActive,
  unpublishWayfindActive,
  WAYFIND_ACTIVE_KEY,
} from "../../pi-agent-ext-wayfind/src/index.js";
// ── REAL planning consumer exports ──
import { isExternalDriverActive, isWayfindActive } from "../src/coordination.js";
import { isPlanIncomplete, readPlanStatus, summarizePlan } from "../src/index.js";

// Restore globalThis between tests so the seam never leaks across cases.
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY];
});

// A realistic grill outcome for this monorepo.
const TOPIC = "Add a `video relay` subcommand chaining t2i → i2v → upscale";
const GLOSSARY = [
  { term: "Relay", definition: "t2i → i2v → upscale chain emitted into one manifest." },
  { term: "Manifest", definition: "The JSONL run.py writes per generation; replayable." },
];
const DECISIONS = [
  { title: "Where does relay live?", answer: "New `video relay` subcommand, not a flag on `video generate`." },
  { title: "Behavior on i2v phase failure", answer: "Keep the image, mark video phase failed, do NOT roll back." },
  { title: "Replay support", answer: "`replay <manifest>` must reconstruct the full relay chain." },
];

describe("coordination seam — real wayfind publish drives planning's reader", () => {
  it("key agreement: wayfind's exported WAYFIND_ACTIVE_KEY is the one it writes to globalThis", () => {
    // If wayfind and planning ever hardcode DIFFERENT key strings, isWayfindActive()
    // silently reads undefined → always false → the yield never triggers. This
    // asserts the producer's exported constant is the actual key on globalThis.
    const state = createRuntimeState();
    publishWayfindActive(state);
    const published = (globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY];
    expect(typeof published).toBe("function");
  });

  it("yield toggle: grill active → planning yields; grill done → planning resumes", () => {
    const state = createRuntimeState();
    publishWayfindActive(state);

    expect(isExternalDriverActive()).toBe(false); // no grill yet
    expect(isWayfindActive()).toBe(false);

    // A grill starts (/grill-me-with-docs mutates this state).
    state.activeGrillBySession.set("sess-1", TOPIC);
    expect(isExternalDriverActive()).toBe(true); // ← planning YIELDS injection + auto-continue
    expect(isWayfindActive()).toBe(true);

    // /grill-done ends it.
    state.activeGrillBySession.delete("sess-1");
    expect(isExternalDriverActive()).toBe(false); // ← planning resumes driving
  });

  it("a wayfinder effort (not just a grill) also makes planning yield", () => {
    const state = createRuntimeState();
    publishWayfindActive(state);
    state.activeEffortBySession.set("sess-2", "orders-redesign");
    expect(isExternalDriverActive()).toBe(true);
  });

  it("graceful degradation: after unpublish, the reader returns false and never throws", () => {
    const state = createRuntimeState();
    publishWayfindActive(state);
    state.activeGrillBySession.set("s", "x");
    expect(isExternalDriverActive()).toBe(true);

    unpublishWayfindActive();
    expect((globalThis as Record<string, unknown>)[WAYFIND_ACTIVE_KEY]).toBeUndefined();
    let result: unknown = "unset";
    expect(() => {
      result = isExternalDriverActive();
    }).not.toThrow();
    expect(result).toBe(false); // planning behaves exactly as standalone
  });
});

describe("grill → plan handoff — real buildPlanSeed parses via real readPlanStatus", () => {
  it("seeds a task_plan.md that planning recognizes as incomplete (ready for /plan-execute)", () => {
    const seed = buildPlanSeed(DECISIONS, GLOSSARY, TOPIC);
    expect(seed).not.toBeNull();

    const cwd = mkdtempSync(join(tmpdir(), "pwf-wayfind-seed-"));
    try {
      writeFileSync(join(cwd, "task_plan.md"), seed as string, "utf8");

      const status = readPlanStatus(cwd);
      expect(status.exists).toBe(true);
      expect(status.totalPhases).toBeGreaterThanOrEqual(1);
      expect(status.pendingPhases).toBeGreaterThanOrEqual(1);
      expect(isPlanIncomplete(status)).toBe(true); // ← /plan-execute would activate
      expect(summarizePlan(status)).toMatch(/\d+\/\d+ phases complete/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("the glossary terms survive into the seeded plan (domain artifacts cross the handoff)", () => {
    const seed = buildPlanSeed(DECISIONS, GLOSSARY, TOPIC);
    expect(seed).not.toBeNull();
    expect(seed).toContain("**Relay**");
    expect(seed).toContain("**Manifest**");
  });

  it("every resolved decision is represented in the seed", () => {
    const seed = buildPlanSeed(DECISIONS, GLOSSARY, TOPIC);
    expect(seed).not.toBeNull();
    for (const d of DECISIONS) {
      expect(seed).toContain(d.title);
      expect(seed).toContain(d.answer);
    }
  });
});
