---
type: task
status: complete
---

# 02 — Content-aware freshness fingerprint (in-place-edit staleness)

## Question

How does the D36 freshness gate detect an in-place card edit (same file count, changed content) cheaply enough to run every session?

## What to build

Retrieval's freshness gate (currently md-count + embed-model) gains a content-aware aggregate over card files — e.g. per-file size+mtime digest or rolling content hash — so an in-place edit changes the fingerprint and the next rebuild trigger regenerates the index instead of serving the stale one. The flat fallback path remains the safety net: a fingerprint mismatch during a live session still falls back to flat, never blocks retrieval.

## Acceptance

- [x] Fixture-vault suite: edit-in-place, append, rename, delete each flip the fingerprint correctly; identical tree does not — `__tests__/fs-surface.test.ts` "freshness gate fingerprint leg (ticket 02)" (8 tests: identical serves; in-place/append/delete/rename flip; staleFingerprint flat; mtime-rewrite does NOT flip; unreadable folder → null); full package 615 pass / 0 fail, tsc clean
- [x] Real-vault check: an in-place edit + explicit rebuild produces a hier index whose card content matches the md (spot-check receipt) — measured 2026-08-24 on the live study-news vault (61 cards): in-place edit flips the gate verdict to flat; explicit rebuild (1381ms) re-stamps `index fp == live fp`; the edit marker is present in the card's indexed body; restore+rebuild returns to the original fingerprint (vault left as found)
- [x] Startup cost A/B receipt: gate evaluation stays negligible (it runs every session); no new breach entries in perf.jsonl — fingerprint compute measured **1ms** on the live vault; one-shot wall 6.72s/6.68s post-change vs the 6.2–7.3s session baseline (within noise; the gate runs per retrieval, not at startup); perf.jsonl untouched by this change (kcard lane, no hermes ops added)
- [x] D14: independent reviewer pass — APPROVE (inline, second consecutive silent reviewer subagent; disclosed in the PR). Key review finding FIXED in-change: the rebuild fingerprint previously excluded parse-skipped files while the gate hashed everything — the two could disagree forever; now both hash every READABLE .md via the shared `fingerprintOf` (parse-failed files ride the fingerprint, unreadable files are absent from both / gate-null → flat)
