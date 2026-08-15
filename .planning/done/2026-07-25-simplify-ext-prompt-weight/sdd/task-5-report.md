# Task 5 (zk-spawn) — Phase-3 skill-unload verification enabler

Enables the Phase-3 A/B test (does the LLM still behave well when a Superpowers
skill is unloaded?). Two parts: (A) a knob to **unregister** a pinned skill
(without editing its `SKILL.md` — ADR-0004), and (B) a subprocess probe mode
that runs a **real `pi -p`** so the knob actually takes effect.

## Part A — `PI_SUPERPOWERS_SKILL_EXCLUDE` knob

### Design

`bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` advertises skills to pi
via the `resources_discover` handler (`skillPaths`). Historically it returned
the single `skills/` dir and let pi recurse into every `<name>/SKILL.md`.

The knob (`PI_SUPERPOWERS_SKILL_EXCLUDE`, a comma-list of skill dir-names)
changes the advertisement **only when non-empty**:

- **Exclude empty/unset** → return `[skillsDir]` (unchanged behavior; preserves
  the silent dedup vs the run-dir `--skill <skillsDir>` splice — both resolve to
  the same real dir, so no `[Skill conflicts]` warnings, no collision).
- **Exclude non-empty** → return the **individual** non-excluded skill-dir
  paths. Each `<name>/` is a pi skill root (a dir whose direct child `SKILL.md`
  makes pi's loader treat it as a skill root and stop recursing), so pi
  registers exactly that skill from each path and the excluded skill is never
  registered. The pinned `SKILL.md` file stays on disk byte-identical.

Pure helpers extracted for testability: `parseSkillExclude(env)` (comma-list →
`Set<string>`, trims/drops empties, injectable env) and
`resolveAdvertisedSkillPaths(skillsDir, exclude)`. The handler reads the env
**per call** (not captured at registration) so a subprocess can flip it between
a fat run and a thin run in the same process image.

### TDD — RED then GREEN

`tests/skill-exclude.test.ts` drives the handler via the same in-memory
ExtensionAPI mock used by `bootstrap.test.ts`.

- **RED** (before impl): 3 of 6 cases failed against the old unconditional
  `[skillsDir]` return — the exclude cases expected 13 individual dirs but got
  `["skills"]` (count 1, basename mismatch):
  ```
  - Expected  - 14   (the 14 skill names)
  + Received  + 1    ("skills")
  ```
- **GREEN** (after impl): all 6 pass. Assertions:
  - unset/empty-string → single `skills/` dir (current behavior preserved);
  - `test-driven-development` excluded → the other 13 advertised as individual
    dirs, each a real skill root (`<path>/SKILL.md` exists);
  - the excluded `skills/test-driven-development/SKILL.md` still exists
    (ADR-0004 — unregister ≠ edit);
  - comma-list + whitespace trimming (`" a ,, b "`);
  - an all-miss exclude list flips representation to individual dirs but
    advertises every real skill.

Full suite green: **121 pass / 0 fail** across 5 files, including
`skills-fidelity.test.ts` (the ADR-0004 byte-equality pin — files untouched).
`biome check` + `tsc` build clean.

## Part B — subprocess probe mode in `scripts/probe-runner.ts`

### Why subprocess

Phase-3 needs fat-vs-thin children that are **behaviorally distinct**. The
existing `spawnSubagent` path boots a child via `createAgentSession`, which does
**not** load this repo's skills (they load via the dev-bootstrap
`load-run-dir-resources` patch, only present in a real `pi` invocation). So on
that path, fat and thin are identical regardless of the knob. A real `pi -p`
loads repo skills **and** honors the exclude env.

### The `-ns` requirement (key finding)

The run-dir resolver splices `--skill <skillsDir>` into argv (manifest
`skills[]`). pi's loader processes paths in order and dedups by canonical real
path + name (first wins) — so `--skill <skillsDir>` loads **all 14** skills
**before** the extension's `resources_discover` runs, and the extension's
filtered paths dedup away silently. **The exclude knob is defeated unless the
extension is the sole skill source.**

The lever: pass `-ns` / `--no-skills`. `run-dir/resolve.ts`'s
`suppressResolvedArgv` drops every `--skill <path>` pair when `noSkills` is in
the user-typed flags, and pi's args parser (`cli/args.js:140`) honors `-ns`
position-independently. With `-ns`, no `--skill` is spliced; skills load **only**
via the extension's `resources_discover`, so the knob is authoritative. Both fat
and thin use `-ns` so the **only** variable between them is the exclude env.

Verified the loader mechanics in pi's dist (`resource-loader.js`
`extendResources` is not gated by `noSkills`; `updateSkillsFromPaths` only
short-circuits to empty when `noSkills && skillPaths.length === 0` — extension
paths still load). `dispatchPi` defaults `noSkills: true` (documented).

### Design

- `--mode <subagent|pi>` (default `subagent` — Phase 1/2 unchanged).
- `dispatchPi(prompt, { env, timeoutMs, noSkills })`: spawns
  `bun <repo>/bun-apps/pi-agent/src/cli.ts -p "<prompt>" -ns`, merges `env` onto
  `process.env`, drains stdout+stderr concurrently (no pipe deadlock), 300s
  timeout (`PROBE_PI_TIMEOUT_MS`, SIGKILL on expiry), surfaces non-zero exit /
  timeout in the result (never throws — the run completes and the table prints).
  `toolCalls: []` (no transcript from `-p`).
- `ProbeDispatcher` abstraction: `runProbe(p, probeDispatch)` — the probe
  dispatch is mode-swappable; the **judge** always runs on the in-process
  subagent path (a neutral grader that needs no skills, so it's identical across
  fat/thin).
- `--ab-skill <name>`: run each probe TWICE — fat (`piDispatcher({})`) and thin
  (`piDispatcher({ [SKILL_EXCLUDE_ENV]: name })`) — judge both, print a per-probe
  delta (`fat=[..] thin=[..] Δ=[..] struct:.. verdict`), gate on
  `passed(thin, fat)` from `probes/types.ts`. Implies `--mode pi`; mutually
  exclusive with `--record`/`--baseline`.
- Existing `--baseline`/`--record` + subagent mode unchanged.

### Smoke evidence

1. **Core mechanism** — bare `pi -p "Reply with exactly one word: READY" -ns`
   → stdout `READY`, exit 0, clean stderr. Proves `pi -p` boots, loads repo
   skills via the extension under `-ns`, and emits the model reply on stdout.
2. **`--mode pi` single-run** — a trivial smoke probe through the full runner:
   ```
   [probe-runner] running 1 probe(s) [mode=pi]…
     → smoke-pi-mode … done (72.0s) struct=true scores=[3]
   === results ===
   smoke-pi-mode                      struct:ok  [3] PASS
   ```
   Exercised dispatchPi → structural → judge subagent → table → exit 0.
   **This smoke caught a real bug** (first run): `dispatchPi`'s return literals
   omitted the `toolCalls` field required by `ProbeDispatchOutput`; Bun's runtime
   doesn't typecheck so it ran and crashed at `probeRes.toolCalls.length`. Fixed
   (both return paths now include `toolCalls: []`), re-smoked green.
3. **`--ab-skill` A/B plumbing** — same trivial probe, A/B mode:
   ```
   [probe-runner] A/B 1 probe(s) — fat vs thin (PI_SUPERPOWERS_SKILL_EXCLUDE=test-driven-development) via pi -p -ns…
     → smoke-pi-mode fat… thin… done (155.1s) fat=[0] thin=[3] Δ=[+3]
   === A/B results (fat vs thin) ===
   smoke-pi-mode                      fat=[0] thin=[3] Δ=[+3] struct:ok PASS
   [probe-runner] A/B overall: thin within tolerance of fat
   ```
   Confirms the fat/thin loop, env injection into the child, delta table, and
   `passed(thin, fat)` gate. (The fat=0/thin=3 split is judge noise on a
   non-skill-dependent smoke probe — not meaningful Phase-3 data; Task 6 runs
   the real skill-dependent probes.)

## Files changed

- `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` — `SKILL_EXCLUDE_ENV`
  const, `parseSkillExclude()`, `resolveAdvertisedSkillPaths()`,
  `listSkillDirNames()`; `resources_discover` honors the knob; added
  `readdirSync`/`statSync` imports.
- `bun-apps/pi-agent-ext-superpowers/src/index.ts` — re-export the new helpers.
- `bun-apps/pi-agent-ext-superpowers/tests/skill-exclude.test.ts` — new (TDD).
- `scripts/probe-runner.ts` — `dispatchPi`, `ProbeDispatcher`,
  `piDispatcher()`, `--mode`/`--ab-skill` parsing, A/B run + `formatAbRow()`.

## Concerns

1. **End-to-end exclude verification is code-analysis, not behavioral.** The
   Part-A unit test proves `resolveAdvertisedSkillPaths` returns 13 paths under
   exclude; the `-ns`→extension-sole-source link is proven by reading pi's
   `resource-loader.js`/`skills.js` + the smoke proving `pi -p -ns` boots and
   returns. What is **not** proven here is that a real Phase-3 probe, with the
   excluded skill absent, **behaves** differently (e.g. the model no longer
   follows TDD ordering). That is exactly Task 6's job (the constraint forbids
   me running Phase-3 A/B probes). The plumbing is ready for it.
2. **`-ns` hides *other* extensions' skills too** (wayfind, obsidian, …) in pi
   mode. For Phase-3 that's a feature (less noise; only superpowers is the
   variable), but a `--mode pi` user who wants all skills present would need to
   drop `-ns` — at which point the exclude knob is silently defeated by the
   `--skill <skillsDir>` splice. `dispatchPi({noSkills:false})` is available but
   the runner always passes `-ns`; documented in the block comment.
3. **Cost/latency.** Each `pi -p` dispatch boots a full session (~60–70s
   observed). An A/B run is 2× that per probe + 2 judge subagent calls. Phase-3
   probe sets should stay small; the 300s per-dispatch timeout bounds hangs.
4. **Judge noise.** Observed in smoke (fat=0/thin=3 on an identical-shape
   trivial probe). The `passed()` ±1 tolerance mitigates single-item noise, but
   Task 6 should average or re-run borderline cases.
