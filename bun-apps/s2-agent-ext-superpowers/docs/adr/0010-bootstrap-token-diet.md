**ID:** `ADR-superpowers-0010` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0010: Bootstrap token diet (terse sections + deferral pointers)

Date: 2026-08-21
Status: accepted
See: [ADR-0006](./0006-superpowers-subagent-cooperation.md) (the terse-summary +
deferral contract this extends), [ADR-0008](./0008-default-skill-exclusion-policy.md)
(whose "Future work" deferred exactly this), effort
[2026-08-21-harness-streamline](../../../../.planning/2026-08-21-harness-streamline/)

## Context

The bootstrap injected once per session/compaction cost ~2,050 tokens
(ADR-0008's tokenizer numbers): the byte-pinned `using-superpowers` body ~716,
the repo-owned `piToolMapping()` ~765, `piBoundaryOverrides()` ~502, intro ~62.
The two repo-owned sections — 62% of the payload — duplicated detail that
already lived (or now lives) in on-demand reference files.

## Decision

Diet the two repo-owned sections to terse essentials + explicit deferral
pointers (progressive disclosure); keep the pinned skill body byte-identical.
User decision (2026-08-21): trim-to-~900-tok, NOT a lean ~120-tok pointer-only
bootstrap — the body stays injected so the methodology loads without a read.

- `piToolMapping()` keeps only the load-bearing directives an agent must not
  need a `read` to follow: self-contained `task`, `tier` over raw model id,
  `commitScope` + `watchdog:{l2:true}` on implementer/fix dispatches,
  `parallel()` for fan-out, never invent `Task` calls — plus "Full contract:
  references/pi-tools.md — read BEFORE any SDD/subagent dispatch".
- `piBoundaryOverrides()` keeps the five stage words, the disk-check routing
  prose, `grilling`/`to-spec` (the wayfind↔superpowers routing-contract seam),
  and `.planning/<effort>/` as sole artifact home — plus "Detail:
  references/pi-routing.md" (new reference absorbing the removed stage table,
  artifact paths, `sdd-workspace`/`PI_PLANNING_EFFORT`, no-effort fallbacks).

**Budget ratchet** (enforced in `tests/bootstrap.test.ts` so drift is loud):
the two repo-owned sections combined ≤ 1,100 chars; whole payload ≤ 5,900
chars. Landed at 1,093 / 4,194 chars (~1,000 tok; −~1,050/session).

`tests/references.test.ts` pins detail-moved-not-vanished: every token the
sections dropped must survive in `references/pi-tools.md` /
`references/pi-routing.md`.

## Consequences

- Every session/compaction pays ~1,000 tok instead of ~2,050 for the same
  behavioral contract; detail is one `read` away with an explicit pre-dispatch
  instruction to load it.
- Editing the tool/routing detail now means editing a reference file, not the
  injected payload — context cost of doc changes drops to zero for sessions
  that never dispatch.
- `piToolMapping()` prose and `references/pi-tools.md` remain dual-maintained
  at the essentials level (ADR-0006's rule): rename a tool → update both.
