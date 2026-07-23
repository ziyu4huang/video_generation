## Question

**Research: is a live Layer-2 A/B (tool-gate ON vs OFF on identical tasks)
feasible in this repo, and what's its shape?** Resolved during charting — see
resolution below.

**type:** research
**blocked by:** —

## Resolution

**Verdict: feasible-but-flaky. Proceed with caveats.**

Findings (gathered this charting session):

1. **Headless run exists.** `pi … -p` / `--print` is a non-interactive one-shot
   (one turn, exit) — `bun-apps/pi-agent-cli/src/flag-spec.ts:247`,
   `args.ts:16`, `commands/agent.ts:73`. So the agent CAN be driven on a task
   without the TUI. ✅
2. **Per-tool allow/deny exist** (`-t/--tools`, `-xt/--exclude-tools`) — but that's
   a tool list, not an extension toggle; irrelevant for ON/OFF of tool-gate as a
   whole.
3. **No clean per-run extension-disable.** `--no-extensions` / `-ne` is an
   **ignored no-op** ("pi-compat no-ops; self-trusted / extensions baked in" —
   `flag-spec.ts:323–328`, `args.ts:25`). So toggling tool-gate OFF per-run
   requires one of: (a) edit `run-dir/manifest.json` to drop the tool-gate entry,
   (b) add an env-gate the extension respects (none exists today — only
   `TOOL_GATE_LOG*`), or (c) load a no-op stub factory in its slot. **(a) is the
   pragmatic A/B switch**; (b) is the clean long-term answer and a small change.
4. **External precedent** (web — arXiv + industry, this session): agent
   tool-selection evaluation uses two complementary instruments, which is exactly
   our L1/L2 split: (i) **deterministic probe suites** over intent→tool mappings
   (MetaTool — "should I use a tool, and which"; the "Tool Hallucination Rate"
   probe suite) ≈ **Layer-1**; (ii) **task-success A/B with repeated runs** to
   absorb nondeterminism ≈ **Layer-2**. No single canonical tool-gating benchmark
   exists; consensus is small curated task sets, not large suites.

   Three findings sharpen the downstream tickets:
   - **ToolChoiceConfusion** (arXiv:2606.06284) — larger tool *menus reduce*
     reliability; semantically-plausible-but-unnecessary tools distract → wrong-
     tool calls. **Direct published support for tool-gate's premise** (fewer
     active tools = less confusion). Worth measuring whether the gate realizes it.
   - **Marginal Tool Utility** (arXiv:2607.14108) — tool efficiency = "can a tool
     be removed *without hurting accuracy*?" This is **the named metric for our
     L2 A/B** — adopt the framing for ticket 04/05.
   - **The Tool-Use Tax** (arXiv:2605.00136) — tool-augmented reasoning does NOT
     always beat native CoT; protocol/formatting overhead can negate benefits.
     This is **the savings↔quality tension in published form** — the verdict
     (ticket 05) is genuinely open per the literature, not just our worry.
5. **Flake reality.** LLM A/B is nondeterministic → a single ON-vs-OFF run is not
   evidence. Trustworthy signal needs N repetitions per cell + a success judge
   (tool-usage detection is the cheapest objective signal; rubric/LLM-judge is
   richer). N and judge are still fog → graduated to map "Not yet specified,"
   to be fixed once ticket 04 produces first-run variance.

**Implication for the map:** ticket 04 (L2 task suite + run) is unblocked — proceed,
using manifest-edit (or better, add a `TOOL_GATE_DISABLE` env) as the ON/OFF switch,
repeated runs, and tool-usage-detection as the initial success signal.
