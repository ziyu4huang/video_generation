---
ticket: 01-frame-contract
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: [02, 03, 05]
---
# 01 — Frame contract: the `view_opened` WS frame

## Question

What exact shape does the new `view_opened` frame carry, is it an event or a state snapshot,
and does it enter the 500-frame connect replay?

## Options

- **(A) full absolute URL string** — server composes `${getUrl()}/files/${rootIdx}/${rel}`
  exactly as the notify line does today; frame `{type:"view_opened", url, title?, view?}`.
  - Impact: dumb client (one href). BUT the absolute origin is frozen at emit time — the
    server walks ports on restart, so a replayed frame can carry a stale origin, and frame
    correctness couples to `getUrl()` liveness at broadcast time.
- **(B) structured `{view?, title?, url}` where `url` is path-absolute**
  (`/files/<rootIdx>/<rel>`, already per-segment encoded by the handler); client joins
  `location.origin + url`.
  - Impact: portable across port walks and replay; the single per-segment encoding authority
    (the PR #1458 review fix) stays server-side, in one place; client does a 1-line join.
    Slightly richer client contract.
- **(C) raw components `{view?, title?, path, rootIdx, rel}` with client-side per-segment
  encoding + URL building.**
  - Impact: frame is pure data, but DUPLICATES the per-segment percent-encoding in the shell —
    encode drift re-opens the exact filename bug class (`#`/spaces) PR #1458's review fixed.

### Sub-fork 1 — event vs snapshot semantics

One-shot transient event (toast payload only) vs state-bearing member (also rides
`snapshot.state` so a freshly opened / refreshed shell already knows recent views). Pure-event
is simpler but couples to 02: if the panel is push- or snapshot-fed, this decides whether a
mid-session refresh shows past views.

### Sub-fork 2 — replay policy

Every broadcast auto-appends to the SessionStore ring (TRANSCRIPT_CAP=500, wiring `:296`) and
replays on WS open (`:487`):

- (a) **exclude from the store** — toasts never re-fire on reconnect, but any snapshot-fed
  panel loses history too;
- (b) **include + `ts` field, client age-gates the toast** — replayed frames may update the
  panel but never toast (P1 exactly-once analog, judged by ts);
- (c) **include raw** — every reconnect re-toasts stale frames (spam; reject unless argued).

## Acceptance

- Frame is a TYPED WebFrame union member (settled inline) with a round-trip test through the
  broadcaster path.
- Replay policy picked and asserted by a test (reconnect behavior is explicit, not accidental).

## Decision (2026-08-16)

**B** — payload `{view?, title?, url}` with path-absolute `url` (`/files/<rootIdx>/<rel>`);
client joins `location.origin + url`; encoding stays server-side. Frame is a typed WebFrame
union member and is INCLUDED in the 500-frame replay carrying `ts`; the client age-gates the
TOAST (stale/replayed frames update the panel but never re-toast). Sub-fork 1: state-bearing
event (replay inclusion supplies the snapshot value); sub-fork 2: (b) include + `ts`.
See `../spec.md` §Decisions · 01.
