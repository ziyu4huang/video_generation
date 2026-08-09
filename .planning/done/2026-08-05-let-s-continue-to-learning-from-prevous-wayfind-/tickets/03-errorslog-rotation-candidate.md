---
type: grilling
status: closed
claimed: agent (2026-08-05)
closed: 2026-08-05 (grilled this session)
blocked by: 01
---

# 03 — The errors.log-rotation candidate: adopt, shelve, or drop?

## Question

`REJECTED.md` lists a **pending candidate** (not yet rejected): *"Per-entry char budget shared between curated memory and raw error capture — auto-captured stack traces (`errorCapture`) compete with curated failures for `failureCharLimit`. Proposed replacement: an append-only `errors.log` capped by rotation, not by the curated char-budget. Status: candidate."*

The audit ([01](01-audit-the-failure-store.md)) found **0 raw `errorCapture` traces currently in the store** — #854 rate-limiting has suppressed them. So decide:

- **Adopt** the `errors.log` separation as a forward guard (raw → `errors.log`; promotion path raw→curated on recurrence)?
- **Shelve** it (revisit only if errorCapture surges again), and focus the budget purely on curated dedup/decay?
- **Drop** it entirely (mark rejected in REJECTED.md with the audit as rationale)?

This ticket also gates the **promotion-path** and **DB↔.md sync** fog patches on the map.

## Context

- `errorCapture` config: `src/config.ts` default `true`; rate-limit knobs in `src/types.ts` (`errorCaptureRateLimit`, `errorCaptureRateWindowMs`, `errorCaptureDedupCacheSize`, all per #854).
- Lock architecture (per failure memory): `proper-lockfile` on the `.md` source-of-truth sits above the repository layer — a new `errors.log` would share that lock path.

## Recommendation seed

Lean **shelve** (with a measurable trigger to re-open): the candidate solves a problem the audit shows isn't currently biting, and dedup/decay are higher-leverage. But the decision is the user's — adopting it is defensible if the goal is a clean raw/curated seam regardless of current volume.

## Resolution — ANSWERED (2026-08-05)

**Decision — DROP the errors.log-rotation candidate (rejected in REJECTED.md).**

The candidate's premise — *"auto-captured stack traces (`errorCapture`) compete with curated failures for `failureCharLimit`"* — is **unfounded in the current implementation**. `src/handlers/error-detector.ts` shows errorCapture:
- captures only **lesson-worthy** failed `tool_result`s (`isLessonWorthy` gate — definitive failures like ModuleNotFoundError / EADDRINUSE, not trivial ones);
- writes a **curated one-line reason** (`firstLessonLine(text).slice(0,200)`), formatted `[<toolName> error] <reason>`, category `failure` — **not a raw stack trace**;
- **3-layer dedups** before any write: ① this-session LRU (64) + rate cap **5 / 10min** (#854); ② **cross-session signature check** — skips the write if an existing failure entry already carries the error; ③ rate cap.

Reconciled with audit [01](01-audit-the-failure-store.md): the store holds **only 1 `failure`-category entry** — errorCapture contributes ~1 entry and raw traces never reach the budget. The inline #854 hardening already does what `errors.log` proposed, without a new store file / rotation logic / DB↔.md sync.

**Artifact change:** moved from REJECTED.md "Candidates under consideration" → the rejection table (old · why killed · replacement = inline #854 hardening).

**Map effects:** clears the two contingent fog patches ("promotion path raw→curated", "DB↔.md sync for errors.log") — both predicated on adopting errors.log. [06](06-migration-and-cutover-plan.md) no longer needs an errors.log cutover; blockers reduce to 04, 05.
