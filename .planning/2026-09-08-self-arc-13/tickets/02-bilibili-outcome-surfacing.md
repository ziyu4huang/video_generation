# Ticket 02 — Bilibili outcome surfacing + WBI key cache (T2)

Status: done · parallel with t03 · before the final redeploy

## Problem

Planner F2+F3 (read in-tree): `lib/bilibili.ts:searchVideos` returns `[]` on
WBI-key fetch failure, on HTTP 412 (`if (resp.status === 412) return []`), and
on `code !== 0`; `fetchBuvid3` FABRICATES a random `BUVID3_...` cookie on any
network error; `fetchHotVideos` mirrors the pattern. The tool layer then reports
`"keyword": 0` and writes a "successful" empty Markdown — a 412 risk-control
block, a dead proxy, and a genuinely empty result are indistinguishable.
Additionally, WBI keys are refetched per search call (per keyword × per page),
multiplying `/x/web-interface/nav` hits and the risk-control exposure.

## Work

1. `lib/bilibili.ts`: `searchVideos` / `fetchHotVideos` / `fetchBuvid3` return
   outcome objects `{ videos, status: "ok" | "blocked-412" | "wbi-unavailable"
   | "network-error", reason }`; process-scoped WBI key cache (fetch once,
   invalidate+refetch once on signature rejection); never fabricate a buvid3.
2. `extensions/research-tool.ts` `collectVideosTool.execute`: render reasons
   into tool text + `details` (e.g. `blocked by risk-control (412): pass
   proxy=http://…`). Tool names/params/schemas UNCHANGED (schema-cost +0).
3. New `__tests__/bilibili-engine.test.ts` (mocked `fetch`, zero network).

## Done when

`bun test` in the package passes, including new tests: `412 surfaces blocked
reason (not empty success)`, `wbi failure surfaces reason`, `wbi keys cached
across keywords (nav called once)`, `buvid3 failure surfaces, never fabricates`;
existing `__tests__/bilibili-wbi.test.ts` stays green.
