# .planning/ Conventions

## Keep wayfind tickets current (standing rule)

Wayfinder efforts under .planning/ are a knowledge source — they must not hold stale or superseded decisions. Rule:

**Any dev work that resolves, changes, or obsoletes a decision documented in a wayfind ticket MUST update that ticket in the same session**, via one of:
- **Resolved / implemented** -> append a `## Resolution` + `closed:` line citing what shipped.
- **Superseded** by a newer effort/decision -> append a Resolution pointing to the superseding ticket/effort + `closed: (superseded)`, and add a cross-link (below) on both efforts' maps.
- **Changed / invalidated** -> append a correction note (do not silently edit the original Question); reopen the ticket's status if needed.

## Cross-effort links

When efforts overlap (one supersedes/absorbs another, shares a decision, or later completes another's open gap), add a `## Cross-effort links` section to BOTH maps with `Supersedes:` / `Absorbed-by:` / `Shares-decision-with:` / `Builds-on:` / `Completed-by:` lines + a 1-line why. This makes overlap visible at a glance and prevents future readers from trusting a superseded ticket. (`Completed-by:` names the effort that closed one of THIS map's open gaps — registered 2026-08-25, kcard-resource-tier close-out.)

## Periodic review

When starting a new effort, skim existing efforts' `## Decisions so far` + `## Cross-effort links` for prior decisions that bear on the new work — cite them rather than re-deciding. If a new effort obsoletes an old ticket, close the old one as superseded the same session; do not let it linger.

## Commit & push .planning/ artifacts (standing rule)

`.planning/` artifacts (effort folders, specs/, plans/) are durable shared planning — MUST be committed & pushed to `origin/main`; never leave a new `.planning/<effort>/` dir untracked (`??`). When you write/update anything under `.planning/`, `git add` it into the branch's commits/PR. See `CLAUDE.md` § Planning artifacts for the full rule. Carve-outs (stay local): `task_plan.md` / `progress.md` / `findings.md`, and the flat `.planning/sdd/` fallback.

## Finished means terminal-with-provenance (registered 2026-09-09, planning-audit)

- A close-out PR MUST flip the effort's front-matter `status:` to `done`/`complete` in the SAME PR that lands its Shipped-as section — #2225 and #2219 both landed Shipped-as prose but left the status stale, and the effort-audit baseline counted 48 such reds across the tree. Run `bun-apps/s2-agent-ext-wayfind/scripts/effort-audit.ts` to verify (exit 0 = every effort is terminal-with-provenance or parked-with-a-dated-reason).
- New effort dirs use content slugs (`YYYY-MM-DD-<what-it-is>`). `self-arc-N` names belong to the closed self-develop series (#2236) and were claimed at merge time by parallel sessions (two same-day collisions, see the self-arc-16 map) — do not name new efforts after them; duplicate round numbers across date prefixes are recorded as info, not errors.

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

## Series arc-number ledger (adopted 2026-09-10, self-arc-19 t01)

- `.planning/arc-ledger.json` is the single registry of claimed SERIES arc numbers
  (self-arc first; schema supports more). Claiming a number = append ONE entry at
  branch time (series, number, path, status, claimedAt, branch; fill mergedPr at
  merge). The old "max folder is N, so N+1 is free" eyeball check RETIRES — the
  guard is the check now.
- Guard: `bun-apps/s2-agent-ext-wayfind/src/arc-ledger.ts`, run by
  `bun-apps/s2-agent-ext-wayfind/tests/arc-ledger.test.ts`. Duplicate
  (series, number) among non-exempt entries, series dirs without entries, and any
  number ACTIVE on origin/main claimed at a different path all fail CI. The
  synthetic duplicate fixture (`tests/fixtures/arc-ledger-duplicate/`) is a
  permanent canary — weakening the rule re-reddens it.
- Pre-ledger duplicate numbers (13/14/15 ×2 and the dual-arc-18 incident) are
  `grandfathered: true` entries with notes naming their collision partners —
  encoded, never erased. New claims can NEVER set grandfathered (enforced:
  claimedAt ≤ adopted). Renumber = edit the entry + add renumberedTo/note; never
  delete history. (Supersedes the "duplicate round numbers are info, not errors"
  stance above for SERIES numbers; content-slug guidance for non-series efforts
  stands.)

## Evidence permanence tier (adopted 2026-09-10, self-arc-19 t04/D6)

- `.planning/<effort>/evidence/` is the COMMITTED home for load-bearing receipts
  that maps cite. Caps: ≤256KB per file, ≤1MB per effort dir, text/JSON only (no
  binaries, no base64 blobs). The executor checks `du`/file types before commit;
  a CI size guard is a queued thought, not built yet.
- Citation rule: committed maps cite the committed evidence path
  (`.planning/<effort>/evidence/<file>`), NEVER `output/` — output/ is
  per-worktree gitignored scratch and its receipts die with the tree.
- Retro-migration is NOT a sweep: each effort's scratch migrates when its owning
  map is next touched.
