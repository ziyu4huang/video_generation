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

## Decisive repro (2026-08-18, tools-explicit experiment)

Dispatched a subagent with `tools: ["webui_report"]` AND
`requiredTools: ["webui_report"]`:

- Preflight PASSED (missingRequiredTools checks requiredTools against the
  DECLARED opts.tools — the name was accepted).
- The child ran — but its ACTUAL tool surface was exactly
  `read, bash, edit, write` (the default coding set). webui_report was
  silently ABSENT. The child confirmed: "not present in my session's tool
  surface ... failure mode is silent absence."

So the seam is NOT the preflight (names are accepted) and NOT registration
(getAllTools on a plain cli.ts session lists webui_report — 75 tools): the
allowlist VALUE fails to survive the child-dispatch chain. Prime suspects:

1. `subagent-tool-schema.ts:267` — the default-toolset binding that applies
   "when the caller omits an explicit tools allowlist" may be overriding or
   ignoring extension-registered names.
2. `spawn-subagent-subprocess.ts:117` — the `--tools <csv>` handoff: verify
   the csv actually carried webui_report into the child argv.
3. `cli/sessions/shared.ts` resolveTools/validateToolNames — validateToolNames
   should have thrown on a silently-dropped name (it exists exactly for
   this); it did NOT, so either the name never reached the child's --tools,
   or getActiveToolNames included it while the model-facing filter did not.

Fix shape: make the child tool resolution UNION the explicit allowlist with
extension-registered tool names (or validate at spawn time against the
parent's getAllTools — preflight already has options.getExtensionTools).
