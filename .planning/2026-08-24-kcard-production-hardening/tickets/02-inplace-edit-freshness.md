---
type: task
status: open
---

# 02 — Content-aware freshness fingerprint (in-place-edit staleness)

## Question

How does the D36 freshness gate detect an in-place card edit (same file count, changed content) cheaply enough to run every session?

## What to build

Retrieval's freshness gate (currently md-count + embed-model) gains a content-aware aggregate over card files — e.g. per-file size+mtime digest or rolling content hash — so an in-place edit changes the fingerprint and the next rebuild trigger regenerates the index instead of serving the stale one. The flat fallback path remains the safety net: a fingerprint mismatch during a live session still falls back to flat, never blocks retrieval.

## Acceptance

- [ ] Fixture-vault suite: edit-in-place, append, rename, delete each flip the fingerprint correctly; identical tree does not
- [ ] Real-vault check: an in-place edit + explicit rebuild produces a hier index whose card content matches the md (spot-check receipt)
- [ ] Startup cost A/B receipt: gate evaluation stays negligible (it runs every session); no new breach entries in perf.jsonl
- [ ] D14: independent reviewer pass
