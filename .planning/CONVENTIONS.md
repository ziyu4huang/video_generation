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
