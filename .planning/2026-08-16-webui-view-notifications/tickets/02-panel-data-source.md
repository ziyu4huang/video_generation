---
ticket: 02-panel-data-source
effort: webui-view-notifications
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: [04, 05]
---
# 02 — Views panel data source: push vs poll, and registry unification

## Question

Where does the views panel get its data — push per-change frames vs client poll of an extended
`/api/views` (P2 poll-snapshot analog) — and do `/files`-origin views (`webui:open`) enter the
SAME RenderService registry as iframe render views, or a separate list? **Registry unification
is the crux: it decides whether "view" means one thing in the shell.**

## Options

- **(A) unify in RenderService** — a new url-pointer view kind (e.g. `mode:"url"` + a url/path
  field; `content` optional for it). The open-event handler registers the view; existing
  `view_update` SSE, `/api/views`, and the `#tabs` machinery light up for free; the panel is a
  small list UI over `listViews()` + the same push.
  - Impact: one source of truth, least NEW surface. Costs: `RenderView` shape churn (content
    becomes optional / new field); replace-only semantics make re-open idempotent-ish (same id
    bumps `updatedAt` — good); registry is per-session in-memory (fine — persistence is a
    non-goal). MUST NOT render url views in the `sandbox=""` srcdoc iframe (settled inline) —
    a url view's tab click routes to the 03 click action instead of `renderView`.
- **(B) separate server-side "opened views" ring** — a tiny last-N list (server-side) exposed
  via a new endpoint (e.g. `/api/opened`), pushed via the `view_opened` frame; RenderService
  untouched.
  - Impact: registry untouched, but TWO parallel view concepts in the shell (tabs vs panel),
    two API surfaces, and the panel cannot list iframe render views unless the client also
    merges `/api/views`.
- **(C) pure client-side accumulation** — panel state = `view_opened` frames seen (+ initial
  state only if 01 chose snapshot semantics).
  - Impact: zero server registry work; but state dies on refresh unless snapshot-replay feeds
    it (hard couple to 01 sub-forks), and iframe render views never appear in the panel.

### Sub-fork — push vs poll (applies within A/B)

Push (`view_opened` frame drives the panel update immediately — event-driven, matches the
toast's own trigger) vs poll (client re-fetches `/api/views` on a 1s timer while the panel is
expanded — P2 poll-snapshot analog) vs hybrid (push for new entries, poll as correctness
backstop). Note the shell already has BOTH transports: SSE `view_update` for registry views,
WS for frames — a push-fed panel must pick which channel carries it (WS frame = same trigger
as the toast; SSE = registry-consistent).

## Acceptance

- Data source + registry posture decided; unification (if A) includes the `RenderView`/
  `viewSummary` shape change spelled out for ticket 05.
- Refresh/reconnect behavior stated (what a mid-session reload shows).

## Decision (2026-08-16)

**A** — unify in RenderService with a new view kind `mode:"url"`; existing `view_update` SSE,
`/api/views`, and tabs machinery light up free. Guardrail: url-view tab clicks must NOT route
into the `sandbox=""` srcdoc iframe — they take the 03-B top-level open/focus action instead.
Panel transport = hybrid: WS `view_opened` push + 1s `/api/views` poll backstop while the
panel is expanded. Id stability: same view re-open updates (bumps `updatedAt`), id derived
from the view name. Refresh: replayed frames repopulate the panel silently; no toasts.
See `../spec.md` §Decisions · 02.
