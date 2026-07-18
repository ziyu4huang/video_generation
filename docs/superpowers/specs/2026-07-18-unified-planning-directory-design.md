# Unified `.planning/` Directory + superpowers/wayfind Handoff — Design

> This is the last spec written under `docs/superpowers/specs/`. Its own
> implementation migrates spec/plan output to `.planning/<effort>/`. Future
> specs land in `.planning/<effort>/spec.md`.

## Goal

Unify all planning documents (decision artifacts from wayfind + execution
artifacts from superpowers) under a single `.planning/<effort>/` root, so the
two halves of the chain read/write the same directory and handoff requires no
cross-directory pointer. superpowers' upstream-verbatim skill files get a
minimal path fork (7 sites); the fork is recorded as a re-appliable patch so a
future upstream sync can re-converge.

## Background

- **Two parallel planning directories today.** wayfind writes
  `.planning/<effort>/{map.md,tickets/,task_plan.md,spec.md}`; superpowers
  writes `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and
  `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
- **`.planning/` is gitignored** (`.gitignore:81`). So wayfind's artifacts are
  scratch (uncommitted); superpowers' are committed archives. Migrating
  specs/plans into `.planning/` untracked would lose the archive semantics —
  so `.gitignore` must change too.
- **superpowers is an upstream-verbatim port** (PR #617, from
  `claude-plugins-official/superpowers`). 7 hardcoded `docs/superpowers/...`
  paths live in skill markdown. Editing them forks from upstream.
- **No automated superpowers sync exists.** `bun-apps/pi-agent/update-pi.sh`
  manages only the 4 `@earendil-works/pi-*` core packages' lockstep; it does
  not touch superpowers. superpowers is currently a manual port from the plugin
  cache.
- **Skill name overlap = 0** (verified): superpowers' 14 methodology skills and
  wayfind's 7 decision-chain skills share no names. This is **not** a dedup
  problem (unlike the removed planning-with-files, which shipped same-named
  copies). The work is directory unification + handoff wiring, not skill
  removal.

## Design

### 1. Unified directory layout

One effort (a unit of work) owns all of its planning artifacts in one folder:

```
.planning/<effort>/
├── spec.md       # brainstorming (superpowers) + to-spec (wayfind) output
├── plan.md       # writing-plans (superpowers) task plan
├── map.md        # wayfinder (wayfind) decision map
├── tickets/      # to-tickets (wayfind) tracer-bullet tickets (NN-slug.md)
└── task_plan.md  # wayfind seedPlan output — the execution trigger
```

**Effort naming:** `YYYY-MM-DD-<slug>` (e.g. `.planning/2026-07-18-add-video-relay/`).
The date prefix sorts efforts chronologically; the slug is the human label.
wayfind's current `slugify(destination)` produces a bare slug, so wayfind must
prepend the date (see §5).

**Handoff is now same-directory:** wayfind's `to-spec`/`to-tickets`/`wayfinder`
write into `.planning/<effort>/`; superpowers' `brainstorming`/`writing-plans`
read+write the same folder; `executing-plans`/`subagent-driven-development`
pick up `plan.md`/`task_plan.md` from there. No cross-directory pointers.

### 2. superpowers path fork (7 sites)

`docs/superpowers/specs/...` → `.planning/<effort>/spec.md`;
`docs/superpowers/plans/...` → `.planning/<effort>/plan.md`. Files touched:

| File | Site | Current | New |
|---|---|---|---|
| `skills/brainstorming/SKILL.md` | L29 | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | `.planning/<effort>/spec.md` |
| `skills/brainstorming/SKILL.md` | L106 | same | same |
| `skills/brainstorming/spec-document-reviewer-prompt.md` | L7 | `docs/superpowers/specs/` | `.planning/<effort>/` |
| `skills/writing-plans/SKILL.md` | L18 | `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` | `.planning/<effort>/plan.md` |
| `skills/writing-plans/SKILL.md` | L160 | `docs/superpowers/plans/<filename>.md` | `.planning/<effort>/plan.md` |
| `skills/subagent-driven-development/SKILL.md` | L277 | `docs/superpowers/plans/feature-plan.md` (example) | `.planning/<effort>/plan.md` |
| `skills/requesting-code-review/SKILL.md` | L60 | `docs/superpowers/plans/deployment-plan.md` (example) | `.planning/<effort>/plan.md` |

The `<effort>` token in skill prose stays literal — skills tell the agent to
"write to `.planning/<effort>/spec.md`", and the agent resolves `<effort>` from
context (same as wayfind already does).

### 3. Fork record + re-apply mechanism (the "change decision")

A patch file captures the 7 substitutions so a future upstream sync can
re-converge without re-deriving them (modeled on MLX's `vendor_patches.py`):

- **Patch file:** `bun-apps/pi-agent-ext-superpowers/migrations/unified-planning-dir.patch`
  — a declarative list of the 7 `(file, old-path-string, new-path-string)`
  substitutions (plain text / sed table, not a git diff, so it's robust to
  upstream reformatting around the line).
- **Apply step:** `bun-apps/pi-agent-ext-superpowers/scripts/apply-patches.sh`
  reads every patch under `migrations/` and applies the substitutions to the
  (freshly synced) skill files. Idempotent: a no-op if the new string is
  already present.
- **Sync flow:** because no automated superpowers sync exists today, this spec
  introduces a thin `bun-apps/pi-agent-ext-superpowers/scripts/update-superpowers.sh`.
  The whole sync + patch flow is **self-contained in the superpowers ext folder**
  — the package owns its own upstream convergence. It (a) copies the plugin-cache
  superpowers tree into the package, then (b) runs `apply-patches.sh`.
  `bun-apps/pi-agent/update-pi.sh` is **unchanged and unrelated** — it keeps its
  single responsibility (pi-* core lockstep) and never touches superpowers.

This keeps superpowers' shipped files forked at rest, while the fork is
reconstructable from upstream + the patch file. A header comment in each forked
file is **not** added (it would itself drift from upstream); the patch file is
the single source of truth for "what we diverged and why".

### 4. `.gitignore` change

Remove the bare `.planning/` line (line 81). Keep the existing root-level
scratch ignores (`task_plan.md`, `progress.md`, `findings.md`) and extend them
to `.planning/*/` so planning artifacts (spec/plan/map/tickets) become committed
archives while per-session transient scratch stays ignored. Net effect:

```gitignore
# Per-session planning scratch (transient working memory — never commit).
task_plan.md
progress.md
findings.md
.planning/*/task_plan.md
.planning/*/progress.md
.planning/*/findings.md
```

(`task_plan.md` stays scratch: it's the live execution trigger, regenerated by
`/wayfind seed`. `spec.md`/`plan.md`/`map.md`/`tickets/` become the committed
record.)

### 5. wayfind adjustments

- **Effort naming:** `slugify()` (exported from `src/wayfinder.ts`, imported by `commands.ts`) prepends `YYYY-MM-DD-` so wayfind-created efforts match the unified convention. Existing bare-slug efforts continue to work (no migration of old folders).
- **Handoff copy:** the generic "execute the plan" guidance added in #624 is
  retargeted to superpowers — point at `executing-plans` / `subagent-driven-development` reading `.planning/<effort>/plan.md`. This is the concrete
  "superpowers hands off the results of to-*" wiring: wayfind produces
  `spec.md`/`tickets/`/`task_plan.md` → superpowers consumes them.
- **`commands.ts` spec/ticket paths** already use `.planning/${effort}/` — compatible; only the `docs/specs/<slug>.md` fallback alternative (L187) is dropped to avoid implying a second spec home.

### 6. Historical files (the 2 existing docs/superpowers/ docs)

The `2026-07-17-wayfind-pwf-status-widget-unification{,-design}.md` pair (the
#624-kept historical snapshots) are migrated to
`.planning/2026-07-17-wayfind-pwf-unification/{spec,plan}.md` to match the new
layout. ADR-0002's two path references to them (L52–53) are updated to the new
locations. ADR-0002's body otherwise stays the historical record (per #624
decision).

## Non-goals

- **No skill content changes** beyond the 7 path strings. superpowers'
  methodology prose stays verbatim (the fork is path-only).
- **No skill dedup.** wayfind keeps all 7 skills (decision dimension; no
  superpowers overlap). This was confirmed: the overlap that motivated the
  request is directory/process, not skill identity.
- **No pi-core or `update-pi.sh` changes.**
- **No migration of old bare-slug `.planning/` folders.** The naming change is
  forward-only.

## Verification

- `bun test` green for `pi-agent-ext-wayfind` (139) and `pi-agent-ext-goal-todo` (106) after the slugify + handoff-copy changes.
- superpowers has no unit test for skill markdown; verify the fork by:
  - `git grep "docs/superpowers/" -- bun-apps/pi-agent-ext-superpowers/skills/` → 0 hits post-fork.
  - `apply-patches.sh` idempotency: run twice on the forked tree → second run is a no-op (exit 0, no diff).
  - round-trip: revert the 7 files to a verbatim upstream copy, run `apply-patches.sh`, confirm the diff equals the committed fork.
- `.gitignore` check: `git check-ignore .planning/<effort>/spec.md` → not ignored; `git check-ignore .planning/<effort>/task_plan.md` → ignored.
- Handoff chain reads end-to-end in skill prose: wayfind `to-*` writes `.planning/<effort>/` → superpowers `writing-plans`/`executing-plans` reads same.
