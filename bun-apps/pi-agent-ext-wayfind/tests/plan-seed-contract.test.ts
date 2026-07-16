/**
 * Plan-seed CONTRACT test — the output shape `buildPlanSeed` MUST emit so that
 * `pi-agent-ext-planning-with-files`'s plan parser (`readPlanStatus` /
 * `parsePlanMetrics`) recognizes the seeded `task_plan.md`.
 *
 * This is intentionally STANDALONE: it does NOT import planning-with-files, so
 * wayfind stays testable in isolation. It pins the exact tokens planning's
 * parser keys on (verified against
 * pi-agent-ext-planning-with-files/src/plan.ts):
 *
 *   - phase heading regex: `/^###\s+Phase\b/i`   →  needs `### Phase`
 *   - status token regex:  `**Status:** pending`  (primary pending matcher)
 *
 * and the structural markers planning's own summary/agent-facing flow assumes
 * (`# Task Plan`, `## Goal`, `## Phases`). If any of these drift in buildPlanSeed,
 * this test fails BEFORE planning does — it is the producer-side half of the
 * grill→plan handoff contract. (The consumer-side round-trip — real buildPlanSeed
 * parsed by real readPlanStatus — lives in planning's tests/wayfind-integration.test.ts.)
 *
 * This complements grill.test.ts: that file covers buildPlanSeed's UNIT behavior
 * (null cases, one-phase-per-decision, skeleton); THIS file covers its CONSUMER
 * contract (the exact strings the downstream parser matches).
 */
import { describe, expect, it } from "bun:test";
import { WAYFIND_ACTIVE_KEY } from "../src/constants.js";
import { buildPlanSeed } from "../src/grill.js";

const DECISIONS = [
  { title: "Where does relay live?", answer: "New `video relay` subcommand." },
  { title: "Failure mode", answer: "Keep the image; do not roll back." },
];
const GLOSSARY = [
  { term: "Relay", definition: "t2i → i2v → upscale chain in one manifest." },
  { term: "Manifest", definition: "JSONL run.py writes per generation." },
];

describe("WAYFIND_ACTIVE_KEY — the coordination-seam contract string", () => {
  it("is exported and equals the globalThis key planning-with-files reads", () => {
    // This literal MUST match the one hardcoded in
    // pi-agent-ext-planning-with-files/src/coordination.ts. A cross-package
    // equality assertion (planning's tests/wayfind-integration.test.ts) guards
    // drift from the other side; here we pin the producer's half.
    expect(WAYFIND_ACTIVE_KEY).toBe("__piWayfindActive");
    expect(typeof WAYFIND_ACTIVE_KEY).toBe("string");
    expect(WAYFIND_ACTIVE_KEY.length).toBeGreaterThan(0);
  });
});

describe("buildPlanSeed — output tokens planning's parser depends on", () => {
  it("emits the planning-with-files-shaped H1 + Goal + Phases structure", () => {
    const seed = buildPlanSeed(DECISIONS, GLOSSARY, "add a video relay subcommand");
    expect(seed).not.toBeNull();
    // Structural markers planning's summary + agent flow assume.
    expect(seed).toContain("# Task Plan");
    expect(seed).toContain("## Goal");
    expect(seed).toContain("## Phases");
    expect(seed).toContain("## Current Phase");
  });

  it("emits a `### Phase` heading — the exact token parsePlanMetrics splits on", () => {
    // plan.ts: `const phaseRegex = /^###\s+Phase\b/i;`
    // buildPlanSeed must emit at least one line matching this, else the parser
    // sees zero phases and isPlanIncomplete returns false (silent handoff break).
    const seed = buildPlanSeed(DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    const phaseHeadings = seed?.match(/^###\s+Phase\b/gim) ?? [];
    expect(phaseHeadings.length).toBeGreaterThanOrEqual(1);
  });

  it("emits `**Status:** pending` — the primary status token classifyPhaseStatus matches", () => {
    // plan.ts classifyPhaseStatus: `/\*\*Status:\*\*\s*pending\b/i`
    // Without this, the phase is classified "unknown" and not counted as
    // pending → isPlanIncomplete could be false even though phases exist.
    const seed = buildPlanSeed(DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    expect(seed).toMatch(/\*\*Status:\*\*\s*pending\b/);
  });

  it("carries the resolved glossary into the seed (the grill's domain artifacts survive handoff)", () => {
    const seed = buildPlanSeed([], GLOSSARY, "topic");
    expect(seed).not.toBeNull();
    expect(seed).toContain("**Relay**");
    expect(seed).toContain("t2i → i2v → upscale");
    expect(seed).toContain("**Manifest**");
  });

  it("carries every resolved decision as an actionable phase line", () => {
    const seed = buildPlanSeed(DECISIONS, [], "topic");
    expect(seed).not.toBeNull();
    for (const d of DECISIONS) {
      expect(seed).toContain(d.title);
      expect(seed).toContain(d.answer);
    }
  });
});
