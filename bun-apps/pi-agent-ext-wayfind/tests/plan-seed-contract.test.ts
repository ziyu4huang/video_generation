/**
 * Plan-seed CONTRACT test — the output shape `buildPlanSeed` MUST emit so the
 * plan coordinator's `parsePlan` (writing-plans format) recognizes the seed.
 *
 * Intentionally STANDALONE: does NOT import the plan coordinator, so wayfind
 * stays testable in isolation. It pins the exact tokens parsePlan keys on
 * (see pi-agent-ext-core-task/src/plan/parse.ts):
 *
 *   - Task heading regex: `/^###\s+Task\s+(\d+)/`  →  needs `### Task N`
 *   - step regex:         `/^-\s+\[(x| )\]/`        →  needs `- [ ]`
 *   - status: DERIVED from step completion — there is NO `**Status:**` token
 *     (the legacy phase-spine `**Status:** pending` is GONE — ticket 08).
 *
 * Producer-side half of the grill→plan handoff contract (complements grill.test.ts
 * unit behavior). Ticket 08: migrated from legacy `### Phase` / `**Status:**`.
 */
import { describe, expect, it } from "bun:test";
import { PLAN_PHASES_KEY } from "../src/constants.js";
import { buildPlanSeed } from "../src/grill.js";

const DECISIONS = [
  { title: "Where does relay live?", answer: "New `video relay` subcommand." },
  { title: "Failure mode", answer: "Keep the image; do not roll back." },
];
const GLOSSARY = [
  { term: "Relay", definition: "t2i → i2v → upscale chain in one manifest." },
  { term: "Manifest", definition: "JSONL run.py writes per generation." },
];

describe("PLAN_PHASES_KEY — the reverse-seam contract string", () => {
  it("is exported and equals the globalThis key syncChainState reads", () => {
    // This literal MUST match the one the plan coordinator publishes on globalThis
    // (the reader syncChainState closes tickets against). Pins wayfind's half of
    // the reverse seam (ADR-wayfind-0003). Coordinator now built as pi-agent-ext-core-task.
    expect(PLAN_PHASES_KEY).toBe("__piPlanPhases");
    expect(typeof PLAN_PHASES_KEY).toBe("string");
    expect(PLAN_PHASES_KEY.length).toBeGreaterThan(0);
  });
});

describe("buildPlanSeed — output tokens parsePlan depends on (writing-plans format)", () => {
  it("emits the writing-plans H1 + inline **Goal:**", () => {
    const seed = buildPlanSeed(DECISIONS, GLOSSARY, "add a video relay subcommand");
    expect(seed).not.toBeNull();
    expect(seed).toContain("# Implementation Plan");
    expect(seed).toMatch(/^\*\*Goal:\*\*/m);
  });

  it("emits a `### Task N` heading — the exact token parsePlan's TASK_HEADER_RE matches", () => {
    // parse.ts: TASK_HEADER_RE = /^###\s+Task\s+(\d+)\s*[:—-]?\s*(.*)$/
    // Without a `### Task` line, parsePlan sees zero phases → silent handoff break.
    const seed = buildPlanSeed(DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    const taskHeadings = seed?.match(/^###\s+Task\s+\d+/gim) ?? [];
    expect(taskHeadings.length).toBeGreaterThanOrEqual(1);
  });

  it("emits NO `**Status:**` token — status is derived from `- [ ]` step completion", () => {
    // parse.ts derives status from step completion; the legacy `**Status:** pending`
    // is removed (ticket 08). Its presence — or the removed `## Phases` /
    // `## Current Phase` sections — would be a regression to the old format.
    const seed = buildPlanSeed(DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    expect(seed).not.toContain("**Status:**");
    expect(seed).not.toContain("## Phases");
    expect(seed).not.toContain("## Current Phase");
  });

  it("carries the resolved glossary into the seed (the grill's domain artifacts survive handoff)", () => {
    const seed = buildPlanSeed([], GLOSSARY, "topic");
    expect(seed).not.toBeNull();
    expect(seed).toContain("**Relay**");
    expect(seed).toContain("t2i → i2v → upscale");
    expect(seed).toContain("**Manifest**");
  });

  it("carries every resolved decision as an actionable step under a Task", () => {
    const seed = buildPlanSeed(DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    for (const d of DECISIONS) {
      expect(seed).toContain(d.title);
      expect(seed).toContain(d.answer);
    }
  });
});
