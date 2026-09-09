---
effort: 2026-08-18-webui-readability
created: 2026-08-18
last: 2026-09-09
status: done
---

# webui-readability — 2026-08-18

## Destination

Webui readability pass, in the user-approved G1>G2>G4 order from the mix-pattern catalog gap candidates: G1 markdown chat feed (#1691), G2 mobile responsive pass (#1692), G4 transcript search/filter (#1693). G3 (multi-session index) stays DEFERRED — needs cross-process discovery, a new architecture decision.

Status: active. User approved the G1>G2>G4 order from the mix-pattern
catalog gap candidates (.planning/knowledge/webui-tui-mix-patterns.md);
G3 (multi-session index) DEFERRED — needs cross-process discovery, a new
architecture decision.

Follow-ups:
1. G1 — markdown chat feed (#1691: message_end broadcast + /api/markdown +
   sandboxed chat bubbles; also fixed the invisible-assistant-reply gap the
   v3 diet left in #1683)
2. G2 — mobile responsive pass (#1692)
3. G4 — transcript search/filter (#1693: substring + all/text/cards chips,
   MutationObserver-driven)
G3 stays DEFERRED (multi-session index — architecture decision pending).

## Shipped-as (backfilled 2026-09-09 by 2026-09-09-planning-audit; every PR git-log-verified merged)

Approved order G1>G2>G4 complete — markdown chat feed, mobile responsive, transcript search/filter; G3 deferred at spec time (never in approved scope). PRs: #1691, #1692, #1693.
