---
effort: 2026-08-15-archify-webui-html
created: 2026-08-15
last: 2026-08-16
status: active
---
# archify-webui-html — visualize archify HTML diagrams over the web protocol

## Destination

Visualize pi-agent-ext-archify's generated HTML diagrams over the web protocol (browser via
the loopback webui), with full fidelity preserved where possible.

## Context (researched facts)

- **archify** renders typed JSON IR → self-contained HTML (inline SVG + JS runtime: theme
  toggle, semantic nav, PNG/SVG/WebM export menu; vendored archify@2.12.0). 3 tools:
  `archify_render` / `archify_validate` / `archify_delta`. Output path from `outputPath`
  param → `ir.meta.output` → `<cwd>/<type>.html`. Today surfaced ONLY as tool-result text
  (absolute path); headless by design ("Never --open"). Committed example:
  `bun-apps/pi-agent-ext-archify/ir/pi-agent-extensions.architecture.html` (597 KB).
- **webui v2** (`bun-apps/pi-agent-ext-webui`): loopback `Bun.serve` + WS/SSE shell;
  `webui:render` event payload `{content, mode:"md"|"html", view, title, images[]}` on the
  shared `pi.events` bus — ANY extension may emit (precedent: wayfind `src/effort-tool.ts`
  emits md views, `view:"wayfind"`). Views = replace-by-id tabs. BOTH md and html render in
  `<iframe sandbox="">` — NO scripts (mermaid/JS impossible in-view); inline static SVG
  renders fine. `/output` static route MIME-allowlist EXCLUDES `.html`/`.svg`
  (octet-stream + nosniff → forced download). No programmatic URL accessor (`WebServer.url`
  private; port `WEBUI_PORT>PORT>0` with +50 walk; first-render `ui.notify` announces URL).
  `webui:render` = non-blocking; `webui:present` = blocking HITL (don't use for display).
- **Prior lineage**: `.planning/2026-08-15-zk-spawn-interactive-ui/interactive-result-ui-research.md` recommends
  "shell-hosted controls + sandboxed render" for interactive results (Approve/Regenerate/Tweak
  shell toolbar; iframe = pure media render).

## Tickets

- `tickets/01-transport.md` — decision, closed — How does archify HTML reach the browser?
- `tickets/02-emitter.md` — decision, closed — Who emits/opens the webui view?
- `tickets/03-script-policy.md` — decision, closed — trust posture for served .html?
- `tickets/04-view-identity.md` — decision, closed — view id scheme & lifecycle for diagram tabs?
- `tickets/05-fog-interactive-result-loop.md` — decision, open (fog, deferred) — adopt
  shell-hosted Approve/Regenerate/Tweak later?
- `tickets/06-webui-file-route-and-open-event.md` — task, closed — config + `/files` route +
  CSP + `webui:open` handler + notify + webui tests.
- `tickets/07-archify-emitter.md` — task, closed (blocks-on 06) — archify emits `webui:open`
  on render+delta success; mock-bus + no-bus tests.
- `tickets/08-docs-and-e2e.md` — task, closed (blocks-on 06, 07) — READMEs, cross-package
  smoke, map status sync.

## Decisions

- **01 — A, full-fidelity file route**: webui serves full HTML via a new file route, opened
  as a top-level browser tab (scripts allowed). Archify's JS runtime (theme/nav/export) is
  the product; static SVG would gut it.
- **02 — generic webui seam**: webui owns a new `webui:open` event + file route; archify emits
  optionally post-render (`events?.emit`, wayfind precedent); no webui → no-op, path printed
  as today. No archify→webui dependency.
- **03 — CSP `sandbox allow-scripts` (+ allow-downloads/allow-popups only if vendored export
  code needs them) + configured directory allowlist** (`fileRoots` option → env
  `WEBUI_FILE_ROOTS`, `:`-separated; empty roots = route serves nothing). Opaque origin →
  no same-origin /api or WS access; realpath containment reused from `/output`.
- **04 — view = IR output basename sans extension** (re-render replaces same view); delta
  compare → `compare-<basename>`; title = `ir.meta.title ?? diagramType`; informs `ui.notify`
  label + forward-compat with future shell tabs (no shell tab today).
- 2026 review: approve-with-fixes — applied (URL per-segment encoding + 6 nits); security posture adversarially verified

## Frontier

cleared (build 06–08 done; 05 fog/deferred open)

## Fog of war

Not charted (distant): full webui redesign / TUI-WebUI co-work model research (zk-spawn
lineage, separate effort); deck/PPTX surfaces; delta-compare UI; image-export HITL
(present controls).

## Decisions so far

- **01 transport = A** — full-fidelity file route, top-level browser tab, scripts allowed
  (closed 2026-08-16).
- **02 emitter = generic webui seam** — webui-owned `webui:open` event + file route; archify
  optional emit, no-op without webui (closed 2026-08-16).
- **03 script policy = CSP sandbox allow-scripts + `fileRoots`/`WEBUI_FILE_ROOTS` allowlist**,
  fail closed (closed 2026-08-16).
- **04 view identity = IR output basename sans extension**; delta → `compare-<basename>`;
  title = `ir.meta.title ?? diagramType` (closed 2026-08-16).
