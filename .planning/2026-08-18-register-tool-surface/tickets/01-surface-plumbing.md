# 01 — surface registerTool tools to session + subagents

status: open

## Problem

SCOPE NARROWED by the 2026-08-18 probe (see map): registerTool tools ARE on the
real-CLI session tool list (75 tools incl. webui_report/webui_present/webui/
archify_render). The remaining gap is SUBAGENT ALLOWLISTS ONLY — preflight
rejects registerTool names in tools/requiredTools. (The orchestrator-seat
blindness was that harness's restricted tool config, not pi-agent.)

## Done when

- [x] A live session can call webui_report directly (the in-process door,
      zero sockets) — PROVEN by the 2026-08-18 getAllTools probe
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
