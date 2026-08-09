---
type: task
status: closed
claimed: wayfinder-session
blocked by: 02
---

# 06 — Close the prior efforts' open tickets + supersede their maps

## Question

Once the unified design ([02](02-unified-coordination-layer.md)+) is settled, close the reconciliation's loose ends: (a) close the older effort's `03` (bootstrap soft-instruction — now moot: no skill editing, the layer reads plans directly), `05`, `06` (folded into [04](04-sync-timing-and-lifecycle.md) / [05](05-multi-plan-representation.md) here) with pointers to this map; (b) supersede `build-plan-coordinator/01` with this unified design; (c) annotate the `let-s-make-superpower-status-can-full-integrate-` + `build-plan-coordinator` maps as **superseded-by this effort** (one line each in their Out-of-scope, or a frontmatter `superseded-by:`).

### Context

- This is the bookkeeping that makes the reconciliation durable — without it, three maps describe overlapping designs and the gap re-hides behind graceful no-ops (the exact failure mode ADR-0003 warns about).

## Resolution

**Closed — bookkeeping executed (wayfinder-session).** All three loose ends tied off:

- **(a)** Closed `let-s-make-superpower-status-can-full-integrate-` tickets [03](../../let-s-make-superpower-status-can-full-integrate-/tickets/03-bootstrap-soft-instruction.md) (moot — no skill editing), [05](../../let-s-make-superpower-status-can-full-integrate-/tickets/05-timing-and-lifecycle.md) (→ 04 here), [06](../../let-s-make-superpower-status-can-full-integrate-/tickets/06-multi-plan-representation.md) (→ 05 here) — each with a Resolution pointing back to this map.
- **(b)** Superseded `build-plan-coordinator/01` — closed with a Resolution mapping every sub-decision it was to grill onto this effort's decisions 02/03 + build 09.
- **(c)** Annotated both prior maps with frontmatter `superseded-by: 2026-07-19-a` + an Out-of-scope supersede line; both Decisions-so-far updated.

Three maps no longer describe overlapping designs — `2026-07-19-a` is the single live coordination-layer effort; the two priors are retained for history but clearly marked superseded.
