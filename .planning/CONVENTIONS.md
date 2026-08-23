# .planning/ Conventions

## Keep wayfind tickets current (standing rule)

Wayfinder efforts under .planning/ are a knowledge source — they must not hold stale or superseded decisions. Rule:

**Any dev work that resolves, changes, or obsoletes a decision documented in a wayfind ticket MUST update that ticket in the same session**, via one of:
- **Resolved / implemented** -> append a `## Resolution` + `closed:` line citing what shipped.
- **Superseded** by a newer effort/decision -> append a Resolution pointing to the superseding ticket/effort + `closed: (superseded)`, and add a cross-link (below) on both efforts' maps.
- **Changed / invalidated** -> append a correction note (do not silently edit the original Question); reopen the ticket's status if needed.

## Cross-effort links

When efforts overlap (one supersedes/absorbs another, or shares a decision), add a `## Cross-effort links` section to BOTH maps with `Supersedes:` / `Absorbed-by:` / `Shares-decision-with:` lines + a 1-line why. This makes overlap visible at a glance and prevents future readers from trusting a superseded ticket.

## Periodic review

When starting a new effort, skim existing efforts' `## Decisions so far` + `## Cross-effort links` for prior decisions that bear on the new work — cite them rather than re-deciding. If a new effort obsoletes an old ticket, close the old one as superseded the same session; do not let it linger.

## Commit & push .planning/ artifacts (standing rule)

`.planning/` artifacts (effort folders, specs/, plans/) are durable shared planning — MUST be committed & pushed to `origin/main`; never leave a new `.planning/<effort>/` dir untracked (`??`). When you write/update anything under `.planning/`, `git add` it into the branch's commits/PR. See `CLAUDE.md` § Planning artifacts for the full rule. Carve-outs (stay local): `task_plan.md` / `progress.md` / `findings.md`, and the flat `.planning/sdd/` fallback.

## Directory shape (purified 2026-08-23)

- **Effort folders** are date-prefixed: `.planning/YYYY-MM-DD-<effort>/` with a `map.md` in
  house shape (see CLAUDE.md). Every effort-like folder MUST have one — retrofit, don't defer.
- **`.planning/done/`** is the archive: completed ad-hoc session dirs (swept by `/wayfind
  done`) plus re-homed historical debris (`done/<date>-<slug>/`, `done/legacy-flat-plans/`,
  `done/legacy-flat-specs/`). Archived content keeps lookup value; it is NOT deleted.
  Completed effort folders stay in place at `.planning/<effort>/` until their cross-references
  age out — do NOT mass-move them into done/.
- **Flat `specs/` + `plans/`** hold only LIVE single-design docs. Anything dated before the
  effort-folder convention (~2026-08-15) belongs in `done/legacy-flat-{specs,plans}/`.
- **Root files**: `CONVENTIONS.md`, `UPSTREAM-SOURCES.md` (durable provenance) and dated
  `REVIEW-YYYY-MM-DD[-topic].md` review reports live at the root by design; they are cited
  from live maps (e.g. `2026-08-16-power-tool-rearch`) — do not sweep them into done/.
- **`knowledge/`** is the skill-candidate staging area per its README — candidates are
  consumed on promotion; finished reports/durable references do NOT belong there.
