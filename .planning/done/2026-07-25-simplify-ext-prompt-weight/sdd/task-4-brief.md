### Task 4: Thin wayfind descriptions + verbose bodies; probe; keep/revert

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/domain-modeling/SKILL.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/grill-memory/SKILL.md`
- Create: `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts`

**Interfaces:**
- Consumes: the Phase-1 harness `runProbes` + `passed`.
- Produces: thinned wayfind skills (always-on description ≤ ~150 chars each; bodies keep the load-bearing trigger logic + ADR/examples).

- [ ] **Step 1: Write the weight test (description ceiling) + Phase-2 probes**

`bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts` asserts each target skill's `description:` frontmatter line is ≤ 150 chars AND still contains its trigger noun (domain-modeling → "ubiquitous language" or "glossary"; grilling → "grill"; grill-memory → "grill_decision" or "memory"). Phase-2 probes (`phase2-wayfind.ts`) cover: grill a 2-option decision; model a 3-term domain; entry-path routing.

- [ ] **Step 2: Run — verify weight test fails (current descriptions ~218–224 tok / long)**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/skill-weight.test.ts )
```
Expected: FAIL on the 150-char ceiling.

- [ ] **Step 3: Thin the three descriptions + trim verbose body sections**

For each of `domain-modeling`, `grilling`, `grill-memory`: shorten the frontmatter `description:` to ≤ 150 chars (keep the trigger noun); in the body, cut redundant preamble/restatement but KEEP every checklist item, example, and the trigger phrase (those are what make the skill fire). This is TDD-edit-by-edit: after each file, re-run the weight test.

- [ ] **Step 4: Run weight test + full wayfind suite**

```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )
```
Expected: all green.

- [ ] **Step 5: Record fat baseline + run Phase-2 probes, diff**

Record baseline from a pre-edit checkout if not already captured, then:
```bash
bun scripts/probe-runner.ts .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts \
  --baseline .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline-wayfind.json
```
Expected: all `PASSED`. Revert any skill whose probe regresses.

- [ ] **Step 6: Commit**

```bash
( cd bun-apps/pi-agent-ext-wayfind && git add skills tests && git commit -m "refactor(wayfind): slim skill descriptions/bodies (probes pass)" )
git add .planning/2026-07-25-simplify-ext-prompt-weight/probes/
git commit -m "test(probes): phase-2 wayfind probes pass vs baseline"
```

---

## Phase 3 — "LLM already knows" skill-unload audit (true A/B)

