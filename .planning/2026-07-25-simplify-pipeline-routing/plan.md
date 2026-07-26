# Simplify pipeline routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse `piBoundaryOverrides()` from 4 verbose runtime rules (3,039 chars) into 2 — one canonical-home invariant + one stage-table discriminator keyed on filesystem state — to kill both routing-confusion pains (heavy glue + mis-routing).

**Architecture:** Single edit site — rewrite the return string of `piBoundaryOverrides()` in `superpowers.ts`. The redirect mechanics (`PI_PLANNING_EFFORT`, `sdd-workspace`, `start-server.sh`, `.gitignore`) are already correct and unchanged; the rule merely states the invariant more tersely + adds a 5-stage table that turns 4/5 routing decisions into disk checks. TDD: update the bootstrap test to assert the new structure (RED), then rewrite the function (GREEN).

**Tech Stack:** TypeScript, Bun, `bun:test`, pi extension API.

## Global Constraints

- **ADR-0004:** the 14 pinned `SKILL.md` files are NEVER edited — this change is bootstrap prose only. `skills-fidelity.test.ts` must stay green.
- **ADR-0005:** two packages stay separate; no merge.
- No new skills, no router skill, no full partition — only the `piBoundaryOverrides()` return string + its test.
- Weight check: new routing section must be meaningfully shorter than the old 3,039 chars.

## File Structure

- **Modify:** `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` — rewrite `piBoundaryOverrides()` (the single return-string function, ~lines 245-256).
- **Modify:** `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` — rewrite the last test ("carries the Path & routing overrides…") to assert the new 2-rule structure + weight.

---

### Task 1: Rewrite the routing rules + test (TDD)

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` (`piBoundaryOverrides()`, ~L245-256)
- Modify: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts` (last `it(...)` block in the "bootstrap payload assembly" describe)

**Interfaces:**
- Consumes: none (self-contained string function).
- Produces: `piBoundaryOverrides()` returns the new 2-rule bootstrap prose; consumed by the context bootstrap injector (unchanged).

- [ ] **Step 1: Update the test to assert the NEW structure (RED)**

Replace the last `it(...)` block (`"carries the Path & routing overrides (boundary convergence, ADR-0004-safe)"`) with:

```typescript
  it("carries the Pipeline routing (2-rule boundary convergence, ADR-0004-safe)", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    // new header (renamed from "Path & routing overrides")
    expect(payload).toContain("## Pipeline routing (this repo)");
    expect(payload).not.toContain("## Path & routing overrides");
    // rule 1: one canonical home — the convergence specifics stay actionable
    expect(payload).toContain("One canonical home");
    expect(payload).toContain(".planning/<effort>/spec.md");
    expect(payload).toContain(".planning/<effort>/plan.md");
    expect(payload).toContain(".planning/<effort>/sdd/");
    expect(payload).toContain(".planning/<effort>/sdd/progress.md");
    expect(payload).toContain(".planning/<effort>/brainstorm/");
    expect(payload).toContain("PI_PLANNING_EFFORT");
    expect(payload).toContain("sdd-workspace");
    // rule 2: stage table discriminator keyed on disk state
    expect(payload).toContain("check what's on disk");
    expect(payload).toContain("DECIDE");
    expect(payload).toContain("SYNTHESIZE");
    expect(payload).toContain("DESIGN");
    expect(payload).toContain("PLAN");
    expect(payload).toContain("EXECUTE");
    // the SYNTHESIZE/DESIGN partition: to-spec vs brainstorming no longer compete
    expect(payload).toContain("to-spec");
    expect(payload).toContain("brainstorming");
    // retired old structure must be gone
    expect(payload).not.toContain("Four runtime rules");
    expect(payload).not.toContain("can I write a plan right now");
    expect(payload).not.toContain("Artifact-home override");
    expect(payload).not.toContain("Entry-path routing");
    expect(payload).not.toContain("Visual-companion convergence");
    // note: "SDD workspace" the bare topic word legitimately remains in rule 1;
    // only the retired header phrase "SDD workspace override" must be gone
    expect(payload).not.toContain("SDD workspace override");
  });

  it("routing section is meaningfully shorter than the old 3039 chars", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    const i = payload.indexOf("## Pipeline routing");
    const section = i >= 0 ? payload.slice(i) : "";
    expect(section.length).toBeLessThan(1500);
    expect(section.length).toBeGreaterThan(800); // sanity: not accidentally empty
  });
```

- [ ] **Step 2: Run the test to verify it fails (RED)**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: FAIL — old function still returns "## Path & routing overrides" + old rule headers; the `not.toContain` assertions + new-header `toContain` assertions fail.

- [ ] **Step 3: Rewrite `piBoundaryOverrides()` (GREEN)**

Replace the entire `piBoundaryOverrides()` function body (the `return \`...\``; string) with:

```typescript
function piBoundaryOverrides(): string {
  return `## Pipeline routing (this repo)

Superpowers and Wayfind are two parallel pipelines sharing the \`.planning/<effort>/\` layout. Two rules:

**1. One canonical home.** Every artifact lives under \`.planning/<effort>/\` — specs → \`.planning/<effort>/spec.md\`, plans → \`.planning/<effort>/plan.md\`, the SDD workspace → \`.planning/<effort>/sdd/\` (briefs/, reports/, reviews/, progress.md), and brainstorm mockups → \`.planning/<effort>/brainstorm/\`. The pinned skills' upstream paths (\`docs/superpowers/\`, \`.superpowers/\`) are overridden at runtime by \`PI_PLANNING_EFFORT\` (\`sdd-workspace\` + the brainstorm \`start-server.sh\` honor it). Never write to the upstream paths when an effort is active.

**2. Pick the pipeline by stage — check what's on disk first.**

| Stage      | Trigger (check disk)                          | Pipeline                                |
|------------|-----------------------------------------------|-----------------------------------------|
| DECIDE     | no spec yet, decisions open / route foggy     | Wayfind — grilling (or wayfinder)       |
| SYNTHESIZE | a grill just settled; spec needed             | Wayfind — to-spec (synthesize only)     |
| DESIGN     | requirement clear, zero open decisions        | Superpowers — brainstorming             |
| PLAN       | spec exists, no plan                          | Superpowers — writing-plans             |
| EXECUTE    | plan exists                                   | Superpowers — executing-plans / SDD     |

Four of five stages are a filesystem check. Only DECIDE-vs-DESIGN needs judgment ("are decisions open?"). When in doubt, DECIDE first — it's cheap insurance against building on a foggy route.`;
}
```

- [ ] **Step 4: Run the test to verify it passes (GREEN)**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: PASS — new header present, old gone, stage labels present, weight < 1500.

- [ ] **Step 5: Run the full suite + fidelity**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: all green, incl. `skills-fidelity.test.ts` (pinned files untouched) and the new `skill-exclude.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/src/superpowers.ts bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "refactor(superpowers): collapse routing rules 4→2 (canonical home + stage table)

piBoundaryOverrides() shrunk from 3039→~1300 chars. Old rules 1/3/4 (three verbose
redirect recipes) collapse into one canonical-home invariant; old rule 2's judgment
discriminator ('can I write a plan now?') becomes a 5-stage table keyed on filesystem
state (4/5 stages are disk checks). The brainstorming/to-spec overlap is partitioned
into SYNTHESIZE vs DESIGN. ADR-0004/0005 untouched."
```
