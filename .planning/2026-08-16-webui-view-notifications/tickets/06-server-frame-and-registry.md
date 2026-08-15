---
ticket: 06-server-frame-and-registry
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocked-by: none
blocking: [08]
---
# 06 — Server: `view_opened` frame + url-view registry

## Goal

Server-side half of `../spec.md`: typed `view_opened` frame (replay-included with `ts`),
`mode:"url"` view kind in RenderService with id stability, and open-event-handler wiring.
Decisions 01-B / 02-A are settled — see `../spec.md` §Decisions.

## Work

- `src/protocol.ts` — typed `view_opened` member in the WebFrame union:
  `{type:"view_opened", view?, title?, url, ts}`; `url` is path-absolute
  (`/files/<rootIdx>/<rel>`), per-segment percent-encoded server-side (01-B — encoding
  authority stays server-side).
- Broadcast + replay — reuse the existing store-wrapper path so every broadcast auto-appends
  to the SessionStore ring (TRANSCRIPT_CAP 500) and replays at connect with `ts` intact; no
  new store plumbing.
- `src/render-service.ts` — new view kind `mode:"url"` (URL pointer; `content` not required
  for it); id stability per spec: `url:<view>` when `view` present, else `url:<url>` —
  re-open of the same id replaces/bumps `updatedAt`, never duplicates. `viewSummary` for
  url views: `mode:"url"`, `title: string | null` normalization.
- `src/open-event-handler.ts` — injectable broadcast closure opt (fire-and-forget, must not
  throw; existing closure pattern); compose the path-absolute url exactly as the notify line
  does today, register the registry view, broadcast the frame; `opts.notify` (terminal line)
  unchanged.
- `src/render-routes.ts` — `/api/views` response shape UNCHANGED
  (`viewSummary {id, title, mode, updatedAt}`; `mode` now includes `"url"`); no url field
  added — the url travels only in the frame payload.
- `src/webui-wiring.ts` — pass the broadcaster/store closures into the handler.

## Tests (gate: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`)

- Frame round-trip through broadcaster + store append; replay includes it with `ts`
  preserved; malformed/unknown frames remain ignored downstream (robustness rule).
- Registry id-stability: same `view` (or same url when `view` absent) re-open → one entry,
  bumped `updatedAt`; distinct views → distinct ids.
- `viewSummary` normalization (`title: string | null`) + unchanged `/api/views` shape.
- Integration: one `webui:open` → registry entry + exactly one broadcast + `opts.notify`
  still called; out-of-allowlist path → no entry, no broadcast, no throw.

## Result
06: view_opened frame (replay-included) + mode:"url" registry + handler wiring; gate 433 pass / 0 fail.
