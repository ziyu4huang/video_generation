# Task 4 Report — Thin wayfind skill descriptions + verbose bodies; probe; keep/revert

**Status:** ✅ DONE (thinning kept; no genuine regression; probe fidelity gap surfaced — see *Concerns*)
**Effort:** `2026-07-25-simplify-ext-prompt-weight` · Phase 2

---

## TL;DR

Thinned the 3 always-on skill **descriptions** named in spec §6 (domain-modeling,
grilling, grill-memory) from 268–298 → 127–136 chars (all ≤ 150, "Use when"
prefix + trigger noun preserved), and trimmed verbose body preamble in each
(kept every checklist item, example, and trigger phrase). Pinned by a new weight
test (6/6). Full suites green: wayfind 173/0, hermes-memory 706/0.

Probes: wrote `phase2-wayfind.ts` (3 fixtures), recorded the fat baseline, ran
thinned, diffed. **No rubric regression** (all deltas 0 or −1, within the
`passed()` tolerance). One structural "FAIL" — identified as LLM run-to-run
noise, root cause = the harness doesn't load skills into the probe child (a
pre-existing harness gap, **not** caused by the thinning). Nothing reverted.

---

## Path discrepancy (read first)

The brief lists `bun-apps/pi-agent-ext-wayfind/skills/grill-memory/SKILL.md` as a
file to modify. **That path does not exist.** `grill-memory` is packaged in the
**hermes-memory** extension: `bun-apps/pi-agent-ext-hermes-memory/skills/grill-memory/SKILL.md`
(confirmed: `wayfind/skills/` has exactly 7 dirs — `domain-modeling, grill-me,
grill-me-with-docs, grilling, to-spec, to-tickets, wayfinder` — pinned by
`tests/skills.test.ts`; `grill-memory` is absent).

Spec §6 explicitly names all three ("domain-modeling, grilling, grill-memory") as
the Phase-2 always-on description targets, so grill-memory **is** in logical
scope; only its on-disk package differs from the brief. Resolution:
- Thinned grill-memory **in place** at its real hermes-memory path.
- The weight test (`bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts`,
  per the brief's location) covers all 3 skills, resolving grill-memory via a
  relative cross-package path with a documenting comment. The read is read-only
  (no import/coupling); ADR-0005 is about wayfind↔superpowers, not hermes-memory.
- Committed grill-memory under the hermes-memory package (its natural home).

---

## TDD evidence

### RED — weight test fails before any src change
```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test tests/skill-weight.test.ts )
```
Result: **3 fail / 3 pass** (6 expect calls). The 3 char-ceiling assertions
failed (298, 283, 268 > 150); the 3 trigger-noun assertions passed (the nouns
were already present in the fat descriptions).

### GREEN — after thinning
Same command → **6 pass / 0 fail**.

### Full suites (post-thin, clean tree)
```bash
( cd bun-apps/pi-agent-ext-wayfind && bun test )       # 173 pass / 0 fail (13 files)
( cd bun-apps/pi-agent-ext-hermes-memory && bun test ) # 706 pass / 0 fail (53 files)
```
`tests/skills.test.ts` (wayfind) still green — thinned descriptions keep the
"Use when" prefix, hyphen-only `name`, ≤1024-char frontmatter, and valid YAML.

---

## Before / after description char counts

| skill (package) | before | after | Δ | trigger noun(s) kept | "Use when" |
| --- | ---: | ---: | ---: | --- | :-: |
| domain-modeling (wayfind) | 298 | **136** | −162 | ubiquitous language · glossary · CONTEXT.md · ADR | ✅ |
| grilling (wayfind) | 283 | **132** | −151 | grill | ✅ |
| grill-memory (hermes-memory) | 268 | **127** | −141 | grill_decision · memory | ✅ |
| **total** | **849** | **395** | **−454 (−53%)** | | |

### Thinned descriptions (final)

- **domain-modeling:** `Use when sharpening a domain model — pinning ubiquitous language, keeping the glossary, and writing CONTEXT.md + ADRs as decisions land.`
- **grilling:** `Use when the user wants to grill a decision or idea — a relentless one-question-at-a-time interview, each with a recommended answer.`
- **grill-memory:** `Use when running a grill-me session — inform each recommendation from memory and capture resolved decisions via grill_decision.`

### Body trims (preamble only; every checklist/example/trigger phrase kept)

- **domain-modeling:** condensed the H1-followup paragraph (restated the
  description) into one line that keeps the load-bearing *active vs consuming*
  distinction ("this fires when you're changing the model, not consuming it").
  Untouched: File structure, all 6 "During the session" subsections (incl. the
  `_Source_:` anchor liveness check + its python snippet), the 3-criteria ADR
  checklist.
- **grilling:** merged the two restating opening paragraphs into one, preserving
  the "one question at a time / wait for feedback" discipline and the
  "bewildering → shallow answers" rationale + "recommended answer per question."
  The "decision tree / dependencies" restatement was cut (it's fully covered by
  the "The discipline" checklist: *Resolve dependencies in order* + *Stay in the
  decision tree*). Untouched: Facts vs decisions, The discipline (5 bullets),
  When to stop.
- **grill-memory:** tightened one orientation sentence ("Two protocols, run for
  every decision in the grill." → "Two protocols per decision."). Untouched:
  READ / WRITE / Discipline sections, both code blocks, the signal taxonomy.

---

## Probe results — thinned vs fat baseline

Fixtures: `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts`
(3 probes, all `validateProbe` ✓). Baseline: `baseline-wayfind.json` (fat,
recorded with the thinning stashed). Full narrative: `phase2-results.md`.

| probe | struct (thin/fat) | rubric thin | rubric fat | Δ | verdict |
| --- | --- | --- | --- | --- | --- |
| wayfind-grill-2-option | ok / ok | [0,2,1] | [0,2,2] | [0,0,−1] | **PASS** |
| wayfind-domain-3-term | FAIL / ok | [3,3,2] | [3,3,3] | [0,0,−1] | FAIL (struct only) |
| wayfind-entry-routing | ok / FAIL | [3,3,3] | [3,3,3] | [0,0,0] | **PASS** |

- **Rubric deltas all within tolerance** (0 or −1) → no behavioral regression
  attributable to the thinning.
- The domain-probe structural FAIL is the hard regex
  `/CONTEXT\.md|glossary|ubiquitous language|\bADR\b/i` flipping between runs.
  Transcript inspection: thinned run proposed `docs/domain/scheduling-model.md`
  (a glossary *equivalent*); fat run named `CONTEXT.md`/`glossary`. Same artifact
  concept both times; the noun varied. The routing probe's struct flipped the
  *opposite* way (thin ok, fat FAIL) — symmetric LLM noise, not a thinning effect.
- **Decisive:** the grill probe scored rubric[0]=0 ("one question at a time") in
  **both** fat and thinned — the child dumped a numbered questionnaire, the exact
  anti-pattern `grilling` forbids. The skill did not fire in either config.

---

## Files changed

| file | change |
| --- | --- |
| `bun-apps/pi-agent-ext-wayfind/skills/domain-modeling/SKILL.md` | thinned description (298→136) + condensed body preamble |
| `bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md` | thinned description (283→132) + merged 2 restating paragraphs into 1 |
| `bun-apps/pi-agent-ext-hermes-memory/skills/grill-memory/SKILL.md` | thinned description (268→127) + 1-line orientation tighten *(brief's `wayfind/` path was wrong — see Path discrepancy)* |
| `bun-apps/pi-agent-ext-wayfind/tests/skill-weight.test.ts` | NEW — Phase-2 weight gate (≤150 chars + trigger noun, per skill); 6/6 |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts` | NEW — 3 Phase-2 probe fixtures |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline-wayfind.json` | NEW — recorded fat baseline (3 ProbeResults) |
| `.planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-results.md` | NEW — run narrative + diff + fidelity analysis |

Commits:
1. `hermes-memory`: grill-memory SKILL.md
2. `wayfind`: domain-modeling + grilling SKILL.md + skill-weight.test.ts
3. `probes`: phase2-wayfind.ts + baseline-wayfind.json + phase2-results.md

---

## Concerns

### 1. Probe fidelity gap (headline) — the harness can't test skill *firing* yet

The probe child is dispatched via `spawnSubagent` → `createAgentSession({
agentDir: getAgentDir() })`. It loads skills only from `<agentDir>/skills` and
`<cwd>/.pi/skills` (neither exists: `~/.pi/agent` has no `skills/`; the repo has
no `.pi/`), plus extension-emitted `resources_discover` paths. The wayfind
extension is **not bridged** into the child (only the `subagent` *tool* is), and
`SpawnSubagentOptions` exposes no `skillPaths`/`resourceLoader` to forward.

**Evidence it's real (not just static reasoning):** the grill probe scored
rubric[0]=0 in both fat and thinned — the child emitted a questionnaire dump
that a loaded `grilling` skill would forbid. If the skill were active, the child
would ask one question and wait. Same for domain (child invented
`docs/domain/scheduling-model.md` instead of the skill's canonical
`CONTEXT.md`/`docs/adr/`). So fat-vs-thinned is a null comparison: the child
sees neither, and the two runs differ only by base-LLM noise — exactly what the
diff showed.

**Implication:** the Phase-2 probe PASS is weak (non-negative) evidence, not
proof that the thinned descriptions still fire. The hard gate here is the
**weight test** (trigger noun + "Use when" preserved by construction). The
fixtures are correct and reusable once the harness bridges skills. This gap
**also blocks Phase 3** (skill-unload A/B), which depends on the child actually
loading/unloading the candidate skill.

**Recommended follow-up (its own task):** thread repo skill dirs into the child —
either add `skillPaths?: string[]` to `SpawnSubagentOptions` (forwarded to
`createAgentSession`, which already accepts them via `loadSkills`) and have
`probe-runner.ts` pass the wayfind + hermes-memory skill dirs; or have
`probe-runner.ts` build a `DefaultResourceLoader` including those dirs and pass
it as `session.resourceLoader`. Re-validate Phase-1's baseline after.

### 2. Brief path bug — `grill-memory` is in hermes-memory, not wayfind

Documented above (*Path discrepancy*). The brief/plan's
`bun-apps/pi-agent-ext-wayfind/skills/grill-memory/SKILL.md` doesn't exist.
Resolved per spec intent (grill-memory IS a Phase-2 target); flagging so the
brief/plan can be corrected and so reviewers aren't surprised by a hermes-memory
commit in a "wayfind" task.

### 3. Minor: probe structural checks are noun-matches, easily noise-bitten

The domain/routing struct flips show that prose-noun regexes are fragile against
a base LLM that invents equivalent artifact names. Once skills load into the
child (concern #1), these regexes should hit more reliably (the skill steers the
exact noun); until then, the judge carries the real signal, as the spec intended
("the judge carries the behavioral signal; structural checks catch the objective
stuff"). No change needed now.
