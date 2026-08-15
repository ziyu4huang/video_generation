---
ticket: 02-emitter
effort: archify-webui-html
type: decision
status: closed
created: 2026-08-15
last: 2026-08-16
blocking: none
note: depends on 01 (transport choice determines what the emitter emits/opens)
---
# 02 — Emitter: who emits/opens the webui view?

## Question

Who emits/opens?

- **(a)** archify extension post-render hook (`events?.emit` like wayfind precedent) with
  webui disabled → graceful no-op.
- **(b)** generic webui feature: a `webui:viewFile` / file-view event any extension can use.
- **(c)** thin glue extension (new pkg) bridging archify receipts → webui.

Consider:

- archify stays webui-optional (peer, not dep);
- replace-on-rerender semantics;
- `receipt.json` sidecars (archify_delta).

## Decision

**Generic webui seam** — a blend of (a) and (b): webui owns a new **`webui:open` event** + the
file route (ticket 01-A); archify emits it **optionally post-render** via `events?.emit`
(wayfind `src/effort-tool.ts` precedent). With no webui present the emit is a no-op (archify
behavior unchanged — path printed in the tool result as today). archify gains NO dependency on
webui: the channel is a string-literal event contract, like wayfind.

This keeps the seam generic (any extension may emit `webui:open` for a file under a configured
root) while archify stays a decoupled peer — option (c)'s glue package would add a repo package
for two lines of emit.

## Acceptance

- Decision recorded with rationale.
- Emitter behavior defined for webui-disabled case.
