---
ticket: 07-archify-emitter
effort: archify-webui-html
type: task
status: closed
created: 2026-08-16
last: 2026-08-16
blocking: [08]
note: blocked-by: 06 (route/event must exist before archify emits meaningfully)
---
# 07 — archify: optional `webui:open` emitter

> Archify half of spec §4.3 (decisions 02/04). webui stays an optional peer — string-literal
> channel contract, like wayfind.

## Goal

`extensions/archify.ts` captures `pi.events`; after `archify_render` success and
`archify_delta` success it emits `webui:open`. No webui present → zero behavior change.

## What to build

1. Factory captures `pi.events`; after render success:
   `events?.emit("webui:open", { path: outPath, view: basename(outPath) sans extension,
   title: ir.meta.title ?? diagramType })`. After delta success: same, with
   `view: compare-<basename sans extension>` (ticket 04 naming).
2. No-bus case: `events` undefined → no-op, no throw; tool result text unchanged (path still
   returned as today).
3. archify imports NOTHING from webui (string-literal event contract).
4. **Tests** (spec §5 archify seams): mock event bus captures emits on render success AND
   delta success; no-bus no-op; payload naming per ticket 04 (basename sans ext,
   `compare-` prefix, title fallback `ir.meta.title ?? diagramType`); **cross-package
   contract pinned** — payload shape asserted as a literal `{ path, view, title }`.

## Acceptance

- `archify_render` success → `webui:open` emitted with the ticket-04 payload naming.
- No webui / no bus → archify behavior byte-identical to today.

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun test --isolate )`
(canonical package gates; see package.json scripts)

## Result

implemented — lib/open-announce.ts + makeRenderTool/makeDeltaTool wiring; archify gate green except pre-existing vendored-bin env failure
