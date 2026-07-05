/**
 * CLI sub-command spec for bun-pi-agent-cli.
 *
 * Lets `bun-pi-agent-cli` expose the power-tool extension as a top-level
 * sub-command:
 *
 *   bun-pi-agent-cli power-tool <diagnostic request...>
 *   bun-pi-agent-cli --model sonnet power-tool "call context_analyzer"
 *
 * The power-tool suite provides 8 diagnostic tools (context_analyzer,
 * agent_inventory, extension_analyzer, knowledge_query, graph_health,
 * todo, ask_user_question, goal_complete). The CLI passes the user's
 * request as a natural-language task; the agent maps it onto the
 * appropriate tool.
 *
 * This file is dependency-free of pi-agent-cli on purpose: the workspace dep
 * direction is pi-agent-cli → pi-agent-ext-power-tool, so the spec is typed
 * with a local structurally-compatible interface. See
 * `bun-apps/pi-agent-cli/src/extensions/types.ts` for the canonical shape.
 */
import extension from "../src/index.ts";

/** Local shape of pi-agent-cli's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

/** All 8 power-tool tool names, as the curated default allowlist. */
const POWER_TOOLS = [
  "context_analyzer",
  "agent_inventory",
  "extension_analyzer",
  "knowledge_query",
  "graph_health",
  "todo",
  "ask_user_question",
  "goal_complete",
];

export const powerToolSubcommand: ExtensionSubcommandSpec = {
  name: "power-tool",
  summary: "runtime diagnostics: context analysis, agent inventory, extension linting, knowledge graph health",
  details: `Usage:
  bun-pi-agent-cli power-tool <diagnostic request...> [options]

The power-tool suite provides 8 diagnostic tools for analyzing pi-agent's own
runtime state. Give a natural-language request as positionals; the agent maps
it onto the right tool.

Tools available:
  context_analyzer    — full context window breakdown (system prompt vs tool schema vs conversation)
  agent_inventory    — dump agent state (extensions, tools, skills, model, cwd) to YAML
  extension_analyzer — lint loaded extensions for duplicate names, oversized schemas, stale refs
  knowledge_query    — query the Zettelkasten knowledge graph by tags or natural language
  graph_health       — audit knowledge graph structural health (dead links, MOC drift, orphans)
  todo               — manage task lists for tracking multi-step progress
  ask_user_question  — ask the user structured questions with 2-4 options each
  goal_complete      — mark the active /goal as complete

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. gemma-4-26b, sonnet)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  bun-pi-agent-cli power-tool "call context_analyzer"
  bun-pi-agent-cli --model gemma-4-26b power-tool "analyze the context window"
  bun-pi-agent-cli power-tool "check if any extensions have duplicate tools"`,
  factory: extension,
  tools: POWER_TOOLS,
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      // No explicit request — prompt the agent to ask or infer intent.
      return "You have access to 8 power-tool diagnostic tools. Help the user " +
        "choose one or infer their intent. Tools available:\n" +
        POWER_TOOLS.map((t) => "  - " + t).join("\n");
    }
    return "You have access to power-tool diagnostic tools. Use the most " +
      "appropriate tool to fulfill this request. The tools are: " +
      POWER_TOOLS.join(", ") + ".\n\n" +
      "Request: " + request;
  },
};
