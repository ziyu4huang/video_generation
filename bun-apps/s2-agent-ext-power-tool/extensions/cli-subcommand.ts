/**
 * CLI sub-command spec for s2-agent's `cli` namespace.
 *
 *   s2-agent cli power-tool <diagnostic request...>
 *   s2-agent cli --model sonnet power-tool "call inspect_context"
 *
 * The user's request is passed through as a natural-language task; the agent maps
 * it onto the appropriate diagnostic tool.
 *
 * The tool allowlist is DERIVED from the extension's own inventory
 * (`POWER_TOOL_NAMES`), never hand-listed. It used to be a literal, and it went
 * stale: it named four tools while six were registered, so `inspect_hooks` and
 * `inspect_tui` were unreachable from the CLI entirely — a hard-coded allowlist
 * does not merely mis-document a tool, it removes it.
 *
 * This file is dependency-free of s2-agent on purpose: the workspace dep
 * direction is s2-agent → s2-agent-ext-power-tool, so the spec is typed
 * with a local structurally-compatible interface. See
 * `bun-apps/s2-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension, { POWER_TOOL_NAMES } from "../src/index.ts";

/** Local shape of s2-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

const TOOLS = [...POWER_TOOL_NAMES];

export const powerToolSubcommand: ExtensionSubcommandSpec = {
  name: "power-tool",
  summary: "runtime diagnostics: context, agent inventory, extension/hook linting, TUI state, pathology detection",
  details: `Usage:
  s2-agent cli power-tool <diagnostic request...> [options]

Runtime diagnostics for s2-agent's own state. Give a natural-language request as
positionals; the agent maps it onto the right tool. Each tool's own description
says what it does — run \`/extensions power-tool\` in a session to browse them.

Tools available:
${TOOLS.map((t) => `  ${t}`).join("\n")}

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. gemma-4-12b, sonnet)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  s2-agent cli power-tool "call inspect_context"
  s2-agent cli --model gemma-4-12b power-tool "analyze the context window"
  s2-agent cli power-tool "check if any extensions have duplicate tools"`,
  factory: extension,
  tools: TOOLS,
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      // No explicit request — prompt the agent to ask or infer intent.
      return "You have access to the power-tool diagnostic tools. Help the user " +
        "choose one or infer their intent. Tools available:\n" +
        TOOLS.map((t) => "  - " + t).join("\n");
    }
    return "You have access to power-tool diagnostic tools. Use the most " +
      "appropriate tool to fulfill this request. The tools are: " +
      TOOLS.join(", ") + ".\n\n" +
      "Request: " + request;
  },
};
