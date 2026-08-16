---
type: grilling
blocking: 01
status: closed
---

## Question

Design the amended one-ticket-per-session rule. Single text site: `procedures/wayfinder.md:131` plus the surrounding chart/work-mode prose; no pin manifest or ADR marks `wayfinder.md` upstream-verbatim — confirm provenance during resolution (if it blocks a direct edit, the amendment lands as an overriding note in the using-superpowers bootstrap layer per ADR-superpowers-0004/0005). Decide the envelope: related-cluster batching vs numeric cap (N tickets or a token envelope — grounded in 01's baseline numbers); eligible ticket types (research is already exempt; task? grilling?); the guardrail against the context pollution the rule originally protected against. Deliverable: amended rule text (a draft to react to) + the edit-site decision.

## Resolution

Decided (human grilling 2026-08-16): envelope shape = **cluster + envelope**. Edit site = **direct edit of `procedures/wayfinder.md`** — provenance confirmed repo-authored during this ticket: no pin manifest (`docs/upstream/` absent), not listed among README "Ported skills" batches, and the rule text lives at a single site (`procedures/wayfinder.md:131`). No ADR-0004/0005 constraint applies; no bootstrap-layer override needed.

Amended rule DRAFT (replaces the sentence `Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.` and its surrounding mode prose; carried verbatim into the spec for execution):

> Two modes. Either way, resolve tickets in **cluster batches**: research and task tickets may batch freely within one session; grilling and prototype tickets resolve one per session unless the remainder of a small, pre-specified, same-decision cluster is trivially related. The batch envelope breaks — close what's resolved and stop the session — when (a) a resolution opens new fog worth charting, (b) you catch yourself re-reading the map to re-orient (context pollution), or (c) a grilling ticket needs the human mid-cluster. The envelope replaces the old blanket one-per-session rule; it is the same guardrail against context pollution, stated as a trip-wire instead of a cap.
