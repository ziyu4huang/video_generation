# Plan: self-arc-16 — the verify arc (wayfind + superpowers) [planned as arc-15; renumbered at rebase]

Planner: hard-problem analyst, dispatched 2026-09-09 (task `task-plan-self-arc-15 (pre-renumber)-the-verify-arc-wayfind`).
Read budget ~14 — held. Baseline `bun run test` run FIRST per the task (see F1).

Directive (2026-09-09): focus on VERIFY `s2-agent-ext-wayfind` + `s2-agent-ext-superpowers`,
"see how far we can do" — verification pushed as far as it honestly goes, gaps recorded, never faked.

## 1. FINDINGS

1. **Both suites are green on the source tree** (measured 2026-09-09, clean tree).
   `bun-apps/s2-agent-ext-wayfind` `bun run test` = 483 pass / 0 fail across 26 files
   (`package.json:scripts.test` = `check` + `test:unit` + `test:probe`) PLUS
   `scripts/probe-ext.ts` PASS — full registration surface by name: commands `grill`,
   `wayfind`; tool `wayfind_effort`; events `session_start`, `turn_end`,
   `session_shutdown`; `BUN_PI_WAYFIND=0` → 0 registrations.
   `bun-apps/s2-agent-ext-superpowers` `bun run test` = 169 pass / 0 fail across 12 files.
   No pre-existing red: any later red is this arc's own regression or finding.
2. **The deployed-leg mechanism is DECIDED by the standalone contract** —
   `bun-apps/s2-agent/src/sh/standalone.ts:registrarCollector` records ONLY
   `registerTool` (`registerCommand` / `registerSkill` / `on` are `() => undefined`),
   and `standalone.ts:loadExt` THROWS when a factory registers zero tools at call
   time ("lazy/event-driven registration is not supported standalone"). Predicted
   consequences (UNVERIFIED until receipted — deployed bytes, not source, decide):
   - **wayfind**: `loadExt("wayfind")` succeeds and exposes `wayfind_effort`, but the
     command surface (`grill`, `wayfind` — the family's PRIMARY surface) is invisible
     to the deployed leg as-is.
   - **superpowers**: the factory (`extensions/superpowers.ts` → `src/superpowers.js`)
     wires skills + session bootstrap, no factory-time tool → `loadExt("superpowers")`
     predicted to throw the documented zero-tools error. Unloadable, not broken.
3. **Deployed trees carry full skills** (measured 2026-09-09):
   `current/ext/wayfind/` = `ext.cjs` + `ext.json` + `procedures/` + `skills/` (16 dirs),
   `current/ext/superpowers/` = `ext.cjs` + `ext.json` + `skills/` (16 dirs); both
   name-sets match source. A deployed-vs-source skills parity receipt (name-set +
   sha256 per SKILL.md + frontmatter `name:`) is cheap and proves shipped-skills ==
   source-skills BY BYTES. NOTE: deployed `current` → `0.10.2+g67a7001` (2026-09-08
   21:27), NEWER than the map's recorded `0.10.1+g9cef1fa` — receipts must resolve
   the symlink and record the label at run time (learning #2: the label is not the
   content).
4. **Source-side gaps the matrix must close** (beyond the green suites):
   - wayfind: no skills-integrity guard — the 16 `skills/*/SKILL.md` frontmatter /
     name-set are unguarded (probe covers registration only);
     `scripts/sweep-zero-citation.ts` is a runnable, NOT wired into `bun run test`.
   - superpowers: `tests/skills-fidelity.test.ts` byte-pins only `PORTED_SKILLS`
     (derived from `scripts/lib/skill-provenance.ts`); the repo-native skills
     (`using-superpowers`, `dispatch-recovery`, `deterministic-edit-dispatch`,
     `probe-extension-introspection`) have no pin or name-set guard;
     skill-exclude tests cover env knobs, not disk inventory.
5. **Receipt-driver mechanics proven by arc-13** (`.planning/2026-09-08-self-arc-13/map.md`
   D4 + Findings): direct tool execute with a stub ctx + temp dirs, no LLM anywhere;
   deployed legs import `<outRoot>/darwin-arm64/current/ext/ext-standalone.mjs`;
   root-level scratch scripts CANNOT import `@repo/*` → drivers must be plain bun
   scripts importing by absolute path (ext-standalone is dependency-free by design).
6. **Scripts-dir-contract**: new top-level `scripts/` entries need the allowlist —
   the plan avoids them entirely (committed package tests + scratch output/ drivers).
7. **Arc-14 numbering collision** (artifact hygiene): `.planning/2026-09-08-self-arc-15/`
   (status `active`, "B3 migrate-in-parallel", 4 tickets) and
   `.planning/2026-09-09-self-arc-16/` (this arc, status `open`) BOTH claim arc-14.
   Recorded here; resolution (renumber / cross-link / absorb) is the main agent's
   call at close-out — this plan does not move either dir.

**Committed vs ad-hoc recommendation** (task asks): skills-integrity / inventory
checks = COMMITTED unit tests in each package (cheap, run in every CI, house style
proven by artifact-leak + skills-fidelity); receipt legs that execute against a
deployed tree = ad-hoc plain-bun drivers under `output/self-arc16-*/` (unit CI must
not require a deployed tree to exist — deploy-e2e precedent). The matrix itself =
this plan + each receipt.json's named-check manifest.

## 2. TICKETS

### T1 — Verification matrix + source-leg execution, BOTH packages [M]

- **Problem**: verification is per-package ad hoc; no enumerated matrix ties surface →
  named check → leg; F4 gaps unguarded.
- **Change**: new committed tests —
  `bun-apps/s2-agent-ext-wayfind/tests/skills-integrity.test.ts` (golden 16-name set;
  per-skill frontmatter `name:` == dir name; non-empty description) and
  `bun-apps/s2-agent-ext-superpowers/tests/skills-inventory.test.ts` (golden 16-name
  set; frontmatter `name:` == dir for repo-native skills — ported stay byte-pinned by
  skills-fidelity, not duplicated). Then source-leg receipt drivers (scratch,
  `output/`) that run each package's `bun run test` and record named checks.
- **Done-when**: both src receipts PASS with named checks: `unit-suite-green`
  (0 fail; record pass counts 483/169 as baselines, do not hard-assert exact
  counts), `probe-ext-surface` + `gate-zero-registrations` (wayfind),
  `skills-integrity` (wayfind 16), `skills-inventory` (superpowers 16),
  `zero-citation-sweep` (wayfind runnable, invoked by the driver).
- **Schema-cost**: +0 (tests only).

### T2 — Deployed-leg receipts: loadExt surface + skills parity (PRE-fix) [M]

- **Problem**: the deployed tree of neither family has ever been receipted; the
  deployed-leg mechanism question is resolved by F2 and needs evidence.
- **Change**: plain-bun scratch driver(s) (no `@repo` imports, F5): resolve
  `current` → record the version label; per family: `ext-dir-present`, `ext.json`
  parses; **skills parity** = deployed name-set + sha256 per SKILL.md vs source;
  wayfind: `loadExt("wayfind")` ok + `tool("wayfind_effort")` + a READ-ONLY execute
  (list-style action, `cwd` = temp `.planning` fixture, arc-13 D4 stub-ctx shape);
  superpowers: `loadExt-expected-throw` — a named check that PASSES by confirming
  the documented standalone limitation (captures the message; evidence, not a fake
  pass); `commands-surface` = RECORDED-GAP pre-T3.
- **Done-when**: `output/self-arc16-wayfind-deployed-<date>/receipt.json` and
  `output/self-arc16-superpowers-deployed-<date>/receipt.json` PASS with every check
  named; gaps recorded as gap entries with reasons. A failing receipt is never
  deleted — fix forward, re-run, keep both (evidence trail).
- **Schema-cost**: +0.

### T3 — Deployed-leg blindness FIX: standalone sees commands + tolerates zero-tool factories [S/M]

Verification-driven infrastructure change — fires NOW on F2 evidence (not contingent):
the deployed leg can never see wayfind's primary surface and cannot load superpowers
at all.

- **Problem**: `standalone.ts:registrarCollector` discards `registerCommand`;
  `loadExt` throws on zero-tool (event-driven) factories (F2).
- **Change**: `bun-apps/s2-agent/src/sh/standalone.ts` — collector also records
  command names; `StandaloneExt.commands()` (additive); `LoadExtOptions.allowEmptySurface`
  opt-in (default stays fail-loud — contract preserved). Unit tests in s2-agent for
  both. Redeploy via the devops deploy CLI (verify-deploy-e2e runs automatically);
  re-run the T2 wayfind leg against the NEW tree → `commands-surface` (grill, wayfind
  by name) flips gap→PASS; superpowers loads with `allowEmptySurface` (empty surface
  recorded as evidence; runtime behavior stays a gap).
- **Done-when**: post-redeploy receipt re-run records the newly resolved version;
  `commands-surface` PASS; `loadExt-allow-empty` PASS; s2-agent suite green;
  schema-cost probe +0 (standalone is an out-of-process script surface — no
  agent-visible tool schemas change).
- **Blockers**: deploy + version-bump ritual (devops CLI); post-merge redeploy +
  receipt re-run before close (arc-12 t05 rule).

### T4 — CONTINGENT fix: what matrix execution uncovers [S]

- **Problem**: unknown until T1–T3 receipts run. Likeliest candidates by class:
  skills-parity drift (→ grep the deployed ext.cjs / skills bytes first, learning #1;
  redeploy if stale), frontmatter drift (→ fix the skill), deployed `wayfind_effort`
  execute failure (→ root-cause in deployed bytes before blaming source, learnings
  #1/#2).
- **Change**: file-level fix named by the first red receipt; regression test wherever
  a product bug (not a driver bug) is found.
- **Done-when**: every red check green on a re-run receipt — or the ticket closes
  NO-OP citing the PASS receipts (evidence, not assertion).

### T5 — Close-out + map hygiene [S]

- **Problem**: this effort's `map.md` Tickets section is unfilled; the arc-14
  numbering collision (F7) is unrecorded on either map; loop close-out ritual pending.
- **Change**: fill `.planning/2026-09-09-self-arc-16/map.md` (Tickets from this plan;
  Decisions: committed-vs-ad-hoc split, standalone extension, receipts-before-fix
  ordering; Frontier = the live-agent gaps; cross-effort links INCLUDING the
  `2026-09-08-self-arc-15` collision note); successor next-goal per
  session-closeout-sop.
- **Done-when**: map.md updated honestly (status per reality), back-links added on
  the arc-13 map, successor file written.

## 3. EXECUTION ORDER

```
T1 (matrix + src legs)  →  T2 (deployed legs, PRE-fix evidence)  →  T3 (standalone
fix + redeploy + re-run deployed legs against the NEW tree)  →  T4 (contingent on
T1/T2/T3 receipts; may interleave wherever a red lands)  →  T5 (close-out)
```

- T2 MUST run before T3 lands: the superpowers expected-throw and the invisible
  commands surface are receipted as the PRE-fix contract — then T3's re-run proves
  the fix. Receipt, fix, re-receipt (arc-13 t01 pattern).
- T3 is the only ticket needing a deploy (devops CLI + version bump; post-merge
  redeploy + final receipt re-run, arc-12 t05 rule).
- T1 has no blockers and can start immediately.

## 4. RECEIPTS PLAN

- `output/self-arc16-wayfind-src-<date>/` — proves the source registration surface
  BY NAME (probe), suite green, 16-skill integrity, zero-citation sweep. No gaps.
- `output/self-arc16-superpowers-src-<date>/` — proves suite green (incl. the
  fidelity pins + artifact-leak via the suite), 16-skill inventory. No gaps.
- `output/self-arc16-wayfind-deployed-<date>/` — proves the shipped bytes register
  the same surface (tool + post-T3 commands), skills parity by sha256, and a real
  read-only `wayfind_effort` execute against a temp `.planning` fixture. Re-run
  after T3's redeploy. RECORDED-GAP: slash-command INTERACTION (grill/wayfind
  command bodies drive a live session) and session-event behavior (turn_end etc.) —
  live-agent-only.
- `output/self-arc16-superpowers-deployed-<date>/` — proves skills parity by sha256,
  manifest presence, and pins the standalone limitation itself as evidence
  (`loadExt-expected-throw` pre-T3; `loadExt-allow-empty` post-T3). RECORDED-GAP:
  session_start/session_compact bootstrap injection, using-superpowers context
  injection, resources_discover advertisement, `PI_SUPERPOWERS_SKILL_EXCLUDE`
  behavior in a deployed host — all live-agent-only.
- Cross-cutting: NO LLM inside any check; drivers are plain-bun scratch scripts with
  absolute-path imports (no `@repo`, F5); every receipt.json records the RESOLVED
  deployed version label + named check results; failing receipts are preserved.

## 5. DESCOPED

- Live LLM skill-flow receipts (ask-matt grilling session, brainstorming →
  writing-plans end-to-end) — needs a live session; violates no-LLM-in-gates;
  frontier per map D3.
- New tui-drive scenario — task constraint; neither family has a TUI surface
  (arc-13 D3 precedent).
- Faking a session host inside standalone to invoke event handlers (superpowers
  bootstrap) — would verify a fake host, not shipped behavior.
- Extending skills-fidelity byte-pins to the repo-native superpowers skills —
  T1's lighter guard suffices; ADR-superpowers-0004 pins exist for upstream
  provenance, which repo-native files lack.
- CI-wiring the deployed-leg receipts into `bun run test` — CI must not require a
  deployed tree (deploy-e2e precedent); committed tests cover the durable parts.
- Renaming either arc-14 effort dir to resolve the F7 collision — main agent's
  call at close-out; recorded, not decided, here.
