/**
 * CLI sub-command spec for pi-agent's `cli` namespace.
 *
 * Lets `pi-agent cli` expose the power-tool extension as a top-level
 * sub-command:
 *
 *   pi-agent cli power-tool <diagnostic request...>
 *   pi-agent cli --model sonnet power-tool "call inspect_context"
 *
 * The power-tool suite provides 4 diagnostic tools (inspect_context,
 * inspect_agent, inspect_extensions, inspect_pathology). The CLI passes
 * the user's request as a natural-language task; the agent maps it onto
 * the appropriate tool.
 *
 * Post-monolith-split (#504/#502/#499): knowledge_query/graph_health moved to
 * pi-agent-ext-knowledge-card, todo/goal_complete moved to
 * pi-agent-ext-core-task, ask_user_question moved to pi-agent-ext-ask-user
 * (merged into pi-agent-ext-core-task 2026-07-18 — no shared code, relocated
 * as the first step of the core-task pi-ext consolidation).
 *
 * This file is dependency-free of pi-agent on purpose: the workspace dep
 * direction is pi-agent → pi-agent-ext-power-tool, so the spec is typed
 * with a local structurally-compatible interface. See
 * `bun-apps/pi-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension from "../src/index.ts";

/** Local shape of pi-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

/** All 4 power-tool tool names, as the curated default allowlist. */
const POWER_TOOLS = [
  "inspect_context",
  "inspect_agent",
  "inspect_extensions",
  "inspect_pathology",
];

export const powerToolSubcommand: ExtensionSubcommandSpec = {
  name: "power-tool",
  summary: "runtime diagnostics: context analysis, agent inventory, extension linting, pathology detection",
  details: `Usage:
  pi-agent cli power-tool <diagnostic request...> [options]

The power-tool suite provides 4 diagnostic tools for analyzing pi-agent's own
runtime state. Give a natural-language request as positionals; the agent maps
it onto the right tool.

Tools available:
  inspect_context    — full context window breakdown (system prompt vs tool schema vs conversation)
  inspect_agent      — dump agent state (extensions, tools, skills, model, cwd) to YAML
  inspect_extensions — lint loaded extensions for duplicate names, oversized schemas, stale refs
  inspect_pathology  — diagnose retry loops / tool error storms / context saturation this session

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. gemma-4-12b, sonnet)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  pi-agent cli power-tool "call inspect_context"
  pi-agent cli --model gemma-4-12b power-tool "analyze the context window"
  pi-agent cli power-tool "check if any extensions have duplicate tools"`,
  factory: extension,
  tools: POWER_TOOLS,
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      // No explicit request — prompt the agent to ask or infer intent.
      return "You have access to 4 power-tool diagnostic tools. Help the user " +
        "choose one or infer their intent. Tools available:\n" +
        POWER_TOOLS.map((t) => "  - " + t).join("\n");
    }
    return "You have access to power-tool diagnostic tools. Use the most " +
      "appropriate tool to fulfill this request. The tools are: " +
      POWER_TOOLS.join(", ") + ".\n\n" +
      "Request: " + request;
  },
};
