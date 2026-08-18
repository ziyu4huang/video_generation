# 01 — surface registerTool tools to session + subagents

status: open

## Problem

registerTool tools are invisible to (a) the orchestrator session tool list and
(b) subagent allowlists (preflight rejects them).

## Done when

- [ ] A live session can call webui_report directly (the in-process door,
      zero sockets)
- [ ] A subagent with tools:["webui_report"] passes preflight and can publish
- [ ] webui_present likewise callable (the control case)
- [ ] schema-cost delta measured and within budget (canary green)
- [ ] gating audit: which registerTool tools are core vs gated families,
      documented per tool

## Notes

Start points: bun-apps/pi-agent/src/static-extensions.ts (registration),
the subagent tool-allowlist construction (pi-agent subagent machinery),
SDK ExtensionAPI.registerTool flow in
node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts.
