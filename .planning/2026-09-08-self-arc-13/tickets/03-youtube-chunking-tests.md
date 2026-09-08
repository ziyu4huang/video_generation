# Ticket 03 — YouTube engine: stats chunking fix + first test file (T3)

Status: open · parallel with t02 · before the final redeploy

## Problem

Planner F4 (read in-tree): `lib/youtube.ts` has ZERO tests, and
`searchYtKeyword` accumulates items across pages then `fetchYtStats` sends ALL
ids in ONE `videos.list` call (`id: videoIds.join(","))` — the endpoint accepts
≤50 ids, so `pages ≥ 2` (>50 ids) fails the request and
`if (json.error) return new Map()` swallows it → every video reports
0 views/likes/duration, silently.

## Work

1. `lib/youtube.ts`: `fetchYtStats` chunks ids into ≤50 per call and merges the
   maps; a stats-fetch error surfaces as a partial/reason on the result (error
   text, not a throw — search results remain usable). Exported signatures stay
   stable (schema-cost +0).
2. New `__tests__/youtube.test.ts` (mocked `fetch`, zero network, zero LLM):
   pagination stop on missing `nextPageToken`, `publishedAfterDays(0) →
   undefined`, `parseIsoDuration` table, normalization + HTML strip, quota-error
   throw (`YouTube API error 403`), `chunks stats batches at 50 ids`
   (call-count/id-count assertions — FAILS on pre-fix code), `missing-key path
   errors cleanly` (the collect_videos YOUTUBE_API_KEY guard via the extension
   factory import).

## Done when

`__tests__/youtube.test.ts` exists and passes; the chunking test demonstrably
fails on the pre-fix `fetchYtStats` (regression proof).
