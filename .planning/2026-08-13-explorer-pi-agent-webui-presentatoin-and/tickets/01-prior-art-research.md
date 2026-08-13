---
type: research
status: closed
claimed: explorer-webui
---
## Question

What prior art informs interactive webui v2 — human-in-the-loop feedback patterns (agent SDKs), interactive-result UIs (canvas/artifacts/IDE), and self-hostable chat UIs (media/tool display + artifact serving + feedback)?

## Resolution

Closed during charting (3 parallel research passes; primary sources only).

**Findings:**
1. pi's 2-seam design (`appexec` bypass-mutex + `sendUserMessage` mutex-gated) is MORE principled than every framework — they conflate steer + structured into one channel (LangGraph replay foot gun, AI SDK two-call, Inkeep routes all through chat endpoint). pi's split lets structured feedback land mid-run without turn-serialization.
2. Media serving: `<img src>` can't attach auth headers → loopback-only = trusted → **static artifacts dir + URL wins** (LibreChat model; 4/4 converge). Reject data-URI for real media. Fixes "media as TEXT paths" architecturally (view payloads carry URLs).
3. Interactive controls: generated media can't be edited in-place → **shell-hosted controls + sandboxed media render** (Artifacts/Cursor). Controls in shell, media in sandboxed view.
4. Image approve/regenerate UX has NO proven standard (Cursor Design Mode steers running apps, not generated stills) → region-overlay→reprompt is an inference → defer annotation.
5. Keep SSE(render-view) + WS(agent+inbound); optionally steal LobeChat resumable-SSE `lastEventId`.
6. Future structured shape (if built): mirror de-facto `{approvalId, toolName, input, state:'requested'|'responded', reason?}` (AI SDK/Inkeep) for portability.

Drives: destination + Notes standing-preferences + fog items. Full syntheses in chat (3 subagent reports).
