---
status: active
---

## Destination

A pinned decision (→ spec, then build) for **interactive webui v2**: generated **images** render inline via a **static artifacts dir + URL route** (fixing v1's "media as TEXT paths"); a **shell-hosted Approve/Regenerate toolbar** sends feedback as **steer text through the existing WS `sendUserMessage` channel** (zero new agent semantics); loopback-only, auth-off (unchanged). Video, annotation, structured-feedback, branching deferred (fog). Builds on webui v1.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-webui` (embedded pi extension). v1 surface: `RenderService` (replace-only named views → tabs), `createToolMirror` (tool_results → "tools" view), `webui_render` tool + `webui:render` event, SSE render-view updates + WS agent-stream + WS inbound control.
- **Existing inbound (grounding)**: WS `/ws` accepts `prompt`/`steer`/`followUp` → `pi.sendUserMessage` (mutex-gated) + `abort` → `ctx.abort()`. `appexec` frame = documented empty seam (bypasses mutex, dispatch no-op) — RESERVED for v2 structured feedback, unused in v1.
- **Skills**: `grilling` + `domain-modeling` (#02); `prototype` (#03).
- **Standing preferences (research-validated)**:
  - Artifact serving = **static dir + URL** (`<img src="/artifacts/...">`); reject base64 data-URI for real media. Loopback = trusted → no tokens.
  - UI = **shell-hosted controls + sandboxed media** (controls in `render-shell.ts`; media in sandboxed view; postMessage for inert signals only).
  - Feedback = **buttons → steer/followUp text** via existing `sendUserMessage` (research: no framework distinguishes steer from structured).
  - Keep **SSE(render-view) + WS(agent+inbound)** split.
- **Loopback/auth**: unchanged — `127.0.0.1` only, `originAllowed` guard, `setTokenAuth(null)`. No remote/multi-user.

## Decisions so far

- [Prior-art survey: HITL SDKs / interactive-result UIs / self-hostable chat UIs](tickets/01-prior-art-research.md) — pi's 2-seam (appexec + sendUserMessage) is the most principled; static-dir+URL serving wins; shell-hosted-controls+sandboxed-media fits; image-approve/regenerate UX has no proven standard.
- [Image-renderer + artifact-serving contract](tickets/02-image-renderer-artifact-contract.md) — port the GUI's `/output/` handler via `setHttpRoutes` (reuse MLX_OUTPUT_DIR, not a new dir); extend tool-mirror to recognize `details.output`/`outputs[].path` → md `![image](/output/0/{basename})` inline in "Tools" (fixes the `[object Object]` bug); md view; loopback-guarded.

## Not yet specified

- **Video renderers** — `<video>` player view (NOTE: serving is covered — the ported `/output/` handler's MIME allowlist includes mp4; only the player view is new). Graduate after image renderer.
- **Annotation/markup** — region-overlay → reprompt (spatial context); research flagged as inference (no proven standard). Graduate if image approve/regenerate insufficient.
- **Structured feedback via `appexec`** — greenfield win: structured events bypass mutex, land mid-run. Graduate when mid-run feedback needed (v1 uses steer-text).
- **Pause-and-resume HITL gate (Tier C)** — agent blocks for approval (LangGraph `interrupt` / AI SDK `needsApproval`); loopback makes state trivial. Graduate when agent-initiated approval needed.
- **Conversation branching/fork** — LibreChat message-tree model. Graduate if linear feedback limiting.
- **Resumable-SSE `lastEventId`** — LobeChat steal (monotonic event ids). Graduate if reconnect view-loss bites.

## Out of scope

- **Remote/multi-user** — loopback-only by design (v1 boundary); origin guard is the trust boundary.
- **Auth tokens** — `setTokenAuth(null)` stays. (Cookie-authed media route only if a non-loopback context ever appears.)
- **Editing media in-place** — generated images/videos are approve/reprompt only.
- **Generic renderer for ALL ext-* results at once** — v1 is media(image)-first; code/diff + plans/structured renderers are separate future efforts.
