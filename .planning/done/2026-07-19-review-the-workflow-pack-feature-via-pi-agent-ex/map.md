> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Wayfinder map: 2026-07-19-review-the-workflow-pack-feature-via-pi-agent-ex

## Destination

A revised `pi-agent-ext-workflow` in which a **workflow-pack is a self-contained, repeatable, agent-cleanable unit**: it ships a canonical **flat top-level folder template** (declaring input/output/intermediate/history as directory structure), **pack-local runtime state** (never `~/.pi`), a **manifest I/O contract**, **bundled Claude-Code-compatible subagent definitions**, and **on-disk intermediates** — so an agent can inspect / clean / purge a pack's state and runs can be repeated. **Full in-place change** (decisions + code + tests). The self-improving loop is the **north star**, deferred to a next effort.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-workflow` — Claude-Code–style dynamic workflows for Pi. Read its `CONTEXT.md` for ubiquitous language (workflow pack, pack resolver, `agentType`, journal, background run). This effort extends that model.
- **Skills every session consults**: `grilling` + `domain-modeling` (sharpen terms; write an ADR the moment a hard-to-reverse decision crystallizes); `grill-memory` (inform recommendations). For execution tickets: `test-driven-development` + `verification-before-completion`.
- **Standing preferences**: plan-first; **Bun only** (never node/npm/yarn); tests via `( cd bun-apps/pi-agent-ext-workflow && bun test )`; build via `bun run build`; lint via `biome check .`. Verify against built `dist/`, not `src/`.
- **Key files**: pack resolver `src/workflow-pack.ts`; manifest model `src/workflow-pack-manifest.ts`; run state `src/run-persistence.ts` (+ `src/workflow-paths.ts` for the current `~/.pi` layout); agentType registry `src/agent-registry.ts`. The new shipped template → `workflow-pack/template/` (must be added to `package.json` `files:` or it won't reach the published artifact).
- **Hard constraint**: `.pi` is **NOT** gitignored in this repo → every pack template must ship a `.gitignore` for its ephemeral dirs (`outputs/ intermediate/ runs/`).

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then open the link for the detail -->

- [01 Destination form — full in-place change](tickets/01-destination-form.md) — decisions + real code (manifest fields, resolver/loader, template, sample pack, tests); spec-first rejected.
- [02 Scope cut — core unit, self-improve deferred](tickets/02-scope-cut.md) — template + I/O contract + repeat-runs + cleanable history + bundled agents + on-disk intermediates IN; self-improving loop OUT (north star).
- [03 State model — pack-local, never ~/.pi](tickets/03-state-model.md) — runtime state lives inside the pack; canonical template ships at `workflow-pack/template/`; inline scripts keep the existing `~/.pi` run-persistence. ADR-worthy.
- [04 Template layout — flat top-level dirs](tickets/04-template-layout.md) — `manifest.json`, `entry.js`, `agents/`, `inputs/`, `outputs/`, `intermediate/`, `runs/`, `.gitignore`; ephemeral dirs gitignored; intermediates persisted to disk (new capability).
- [10 Research — Claude Code subagent format](tickets/10-research-claude-code-subagent-format.md) — `.claude/agents` ≈ `.pi/agents` (name/description/tools/model + body prompt); ONE hard interop trap = `tools` string-vs-array; unblocks 09.
- [05 Manifest I/O contract — hybrid, polymorphic, nested `io:`](tickets/05-manifest-io-contract.md) — optional `io:` block (inputs/outputs/intermediate/runs) + `agents` glob + `version`; schema/vocab only, semantics deferred to 11/06/12/09.
- [11 Repeat-run semantics — timestamped append + content-hash tag](tickets/11-repeat-run-semantics.md) — default `outputs/<ts>/` append (defines 05's naming enum); every run executes fully, tagged by input content-hash for grouping; cache-hit short-circuit deferred.
- [08 Pack identity/versioning — path-hash pack-id + optional semver version](tickets/08-pack-identity-versioning.md) — `pack-id = <name>-<sha256(absPath)[:12]>` (version-INDEPENDENT, derived at resolve); `version` = optional non-empty string (semver recommended), metadata only; unblocks 15.
- [06 Clean/purge surface — safe-by-default + minimal all/last-N](tickets/06-clean-purge-surface.md) — bare `clean` purges only `intermediate/`; `runs/`+`outputs/` need `--scope`+dry-run+`--yes`; retention vocab `all`(default)|`last-N`(`--keep N`), optional `io.*.retention`; 3-tier safety (intermediate🟢 / runs🟡 / outputs🟠); unblocks 12.
- [07 Scaffolder mechanics — `init`→`.pi/`, checked-in runtime redirect](tickets/07-scaffolder-mechanics.md) — `workflow pack init <name>` scaffolds to `.pi/workflows/<name>/` (copies template, empty ephemeral dirs); checked-in packs authored manually + runtime state-redirect to `.pi/workflows/.state/<pack-id>/` (project-local, honors 03); lazy self-provisioning ON; template in `files:`; resolves the portability fog; unblocks 13.
- [09 Bundled subagent defs — single CC-string file + Pi parser fix](tickets/09-bundled-subagent-defs.md) — one canonical `agents/<role>.md` (CC-string `tools:` form, drop-in for Pi+CC); enhance `toStringArray` to accept array OR comma-string → fixes the silent-all-tools security trap globally; precedence project>pack>user; pack `agents/` registered per-run via `packDirs`; `agent()` binds by name + fail-fast validation; unblocks 14 (partly).
- [12 On-disk intermediate mechanics — journal-canonical + opt-in disposable mirror](tickets/12-on-disk-intermediates-mechanics.md) — journal stays the resume source-of-truth; on-disk `intermediate/` is an opt-in (`io.intermediate.persist:true`, default off) mirror named `<phase>/<idx>-<hash>.<ext>`; purge is always safe (mirror disposable, journal untouched); resolves the determinism fog; unblocks 14 (partly).
- [13 Backward-compat/migration — `packId` branch, pack-wins precedence, zero migration](tickets/13-backward-compat-migration.md) — `PersistedRunState.packId?` branches pack-local vs unchanged `createRunPersistence` (inline); pack wins on name collision + warn (zero-regression: only new same-named packs shadow); NO migration; inline/navigator/`workflow_control`/resume verified byte-identical (test gate in 14); unblocks 14.
- [14 Sample pack + tests — foundational layer landed](tickets/14-sample-pack-tests.md) — T1–T8 implemented + verified on branch `workflow-pack-self-contained-unit` (1053 tests / 0 fail, tsc clean, final review APPROVED): manifest io/version/agents, packId, agent-registry tools-fix+packDirs, pack-state resolver, clean/inspect, run-state packId, scaffolder+template, reference pack. Runner-integration (12/11) + CLI/TUI wiring deferred to follow-on tickets.
- [15 Context + ADR close-out — glossary + ADR-0001/0002](tickets/15-context-and-adr.md) — CONTEXT.md "Workflow pack self-containment" subsection added; ADR-0001 (state-model) + ADR-0002 (pack-id path-hash) written; 12 folded into 0001's consequences. **Map destination reached.**

## Not yet specified

<!-- in-scope fog you can't ticket yet; graduates as the frontier advances -->

- **Cross-run cache-hit (opt-in).** 11 chose always-run + content-hash tag as the default (predictable, reproducible). A future opt-in could short-circuit a run whose input-hash matches a prior successful run (return cached outputs unless `--force`). Graduates if/when repeat-runs get expensive enough to want it; leans on the input-hash 11 introduced.

## Out of scope

<!-- work ruled beyond THIS destination; closed, never graduates -->

- **Self-improving work-unit loop** (north star, deferred). Per the scope cut (02), this effort builds the self-contained, cleanable, repeatable unit ONLY. The per-pack feedback record (`feedback.jsonl`), quality-verdict accumulation, and the agent-driven "improve this pack" proposer are a **separate future effort** that consumes the unit this map produces. Returns as a fresh effort once packs exist and accumulate real runs.
