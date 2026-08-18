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

## CONFOUND CORRECTION (2026-08-18, static chain audit) — the repro above is NOT the repo's subagent tool

The 2026-08-18 tools-explicit experiment dispatched through the ORCHESTRATOR
HARNESS's own subagent tool — a DIFFERENT implementation with a restricted
surface (that parent session has no webui_report either; its children get
read/bash/edit/write). The observed "silent drop" is that harness, not
pi-agent-ext-subagent.

Static audit of the REPO chain shows it is SOUND, every hop code-evidenced:

1. subagent-tool.ts L227: buildSpawnOptions(ctx {params...}).
2. subagent-tool-run.ts L419: effectiveTools = params.tools ?? agentDef?.tools ?? defaultActiveTools.
3. spawn-subagent-subprocess.ts L257-261: buildSubagentArgs(promptPath, { tools: opts.tools, ... }).
4. L135-136: args.push("--tools", opts.tools.join(",")) — the csv IS emitted.
5. getPiInvocation -> `pi` launcher shim -> self-resolves to the SAME
   worktree's cli.ts -> load-run-dir-resources patch splices the manifest's
   -e extensions AND --skills -> webui extension registers webui_report in
   the child -> `--tools webui_report` matches a registered name.

Combined with the 2026-08-18 getAllTools probe (#1600: plain cli.ts session
lists webui_report among 75 tools), the repo-side subagent path for
registerTool tools is EXPECTED TO WORK. Definitive live check (needs a
provider, so user-side or an L2 tier): a cli.ts one-shot prompting the model
to call subagent with tools:["webui_report"] + requiredTools:["webui_report"].

Ticket 01 scope: DOWNGRADED to "verify the expected-working path live" —
no known repo defect. Close on that verification.
