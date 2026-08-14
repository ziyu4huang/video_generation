---
status: complete
---

## Destination

A pinned decision (→ spec, then build) for **interactive webui v2**: the webui becomes an **agent-driven, blocking HITL interactive surface** — like `ask-user`. The agent *presents* content (e.g. a generated image for review) by emitting an event and **blocks its turn**; the user's Approve/Regenerate response returns via the reserved **`appexec` bypass-mutex seam**, resolving the blocked turn so the agent resumes with the answer. This **replaces the passive model entirely** — no tool-result mirror, no "tools" view, no fire-and-forget `webui_render` tool. Generated media is served via a static `/output/` URL route (the #02 serving contract survives; the mirror does not). Loopback-only, auth-off (unchanged).

## Notes

- **Reframe (this session)**: the original destination (passive inline image rendering + a steer-text toolbar) is SUPERSEDED. The webui is now **agent-driven + interactive like `ask-user`**: content via agent-emitted events (active, not always-on, not tool-mirrored); the interaction is a **blocking HITL gate** (agent presents → blocks → user responds → agent resumes).
- **`ask-user` model (grounded)**: `ask_user_question` tool → `execute()` blocks on `await ctx.ui.custom()` → user responds → answer returns as the tool result; the `pi.events.emit` side-channel is one-way info (0 listeners). The webui can't use `ctx.ui.custom()` (browser ≠ TUI overlay) but **synthesizes** the same gate.
- **The synthesized gate**: agent presents via event → a tool's `execute()` blocks on a Promise (keyed by id) → user response arrives via **`appexec`** inbound (bypass-mutex; validated/parsed/routed today, dispatch is a no-op) → resolves the Promise → turn resumes with the answer. The `appexec` seam is the "structured feedback bypass-mutex" #01's research called pi's most-principled 2-seam design (Tier C "pause-and-resume HITL gate", pulled forward from fog).
- **What survives from prior tickets**: the `/output/` serving contract (#02 — port handleGalleryImage via setHttpRoutes, MIME allowlist, loopback-guard) serves media in the HITL presentation; the toolbar UX + pinned formulations (#03 — per-image `[Approve][Regenerate…]`, exact text) carry — only the **transport** shifts (fire-and-forget steer → appexec HITL response). Targeting (#03's open question) is moot (the agent knows what it presented).
- **Standing preferences (#01, research-validated)**: pi's 2-seam (appexec + sendUserMessage) most principled; static-dir+URL serving wins; loopback = trusted → no auth.
- **Loopback/auth**: unchanged — 127.0.0.1 only, originAllowed guard, setTokenAuth(null).

## Decisions so far

- [#01 Prior-art survey](tickets/01-prior-art-research.md) — pi's 2-seam most principled; static-dir+URL serving wins. (Foundation for the HITL reframe.)
- [#02 Image-renderer + artifact-serving contract](tickets/02-image-renderer-artifact-contract.md) — **mirror approach SUPERSEDED** by the HITL reframe; the `/output/` **serving contract SURVIVES**.
- [#03 Shell-hosted feedback toolbar UX + formulations](tickets/03-shell-feedback-toolbar.md) — UX + formulations PINNED; transport RE-SCOPED (steer → appexec HITL).
- [#04 Startup status announce](tickets/04-status-announce-enhancement.md) — fires on first rendered content (not session_start); consistent with "not always-on".
- [#05 HITL gate contract](tickets/05-hitl-gate-contract.md) — synthesized blocking gate pinned: `webui_present({content, controls})` tool blocks on a Promise; `webui:present` event pushes content + DECLARATIVE controls; response via `appexec {respond, id, action, tweak?}` (bypass-mutex); structured `{action, tweak?, cancelled?}` return; block-until-response/abort; one pending at a time.

## Not yet specified

- **Image presentation in the HITL channel** — how a generated image is presented for approval (served via /output URL + Approve/Regenerate); the flux2/ltx `details.output` → presentation flow. (Build, after #05.)
- **Drop the mirror** — remove the tool_result mirror + "tools" view; repurpose/remove `webui_render`. (Build, after #05.)
- (Prior fog, still deferred) video, annotation, structured-feedback-shape, branching, resumable-SSE.

## Out of scope

- **Passive tool-result mirroring** — dropped by the reframe.
- **Remote/multi-user**, **auth tokens**, **editing media in-place** — unchanged.
