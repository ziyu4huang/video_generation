/**
 * CLI sub-command spec for pi-agent.
 *
 * Lets `pi-agent` expose the web-access extension as a top-level
 * sub-command:
 *
 *   pi-agent cli research <natural-language query...>
 *   pi-agent cli --model sonnet research "RAG vs graph RAG benchmarks 2026"
 *
 * The web-access tools (web_search, fetch_content, get_search_content) are
 * agent-driven, so the CLI passes the user's query as a natural-language task.
 * With pi-obsidian baked into every CLI session, the agent can additionally
 * save a synthesized digest into the vault via obsidian_create — turning a web
 * search into durable knowledge.
 *
 * This file is dependency-free of pi-agent on purpose: the workspace dep
 * direction is pi-agent → pi-agent-ext-web-access, so the spec is typed
 * with a local structurally-compatible interface (TS structural typing makes it
 * assignable to pi-agent's `ExtensionSubcommandSpec`). See
 * `bun-apps/pi-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension from "../index.ts";

/** Local shape of pi-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

/**
 * Web-access tools + the baked-in vault tool for saving digests.
 *
 * `obsidian` is the single unified vault tool (action: "create" | "search" |
 * …) — pi-agent-ext-obsidian consolidated the old per-verb tool names
 * (obsidian_create, obsidian_search, …) into one tool with an `action` param.
 * Listing the old names here made `--tools`'s fail-fast validator reject this
 * subcommand's own default allowlist on every invocation (see
 * validateToolNames in pi-agent/src/cli/sessions/shared.ts).
 */
const RESEARCH_TOOLS = ["web_search", "fetch_content", "get_search_content", "obsidian"];

export const researchSubcommand: ExtensionSubcommandSpec = {
  name: "research",
  summary: "web research: search → fetch → synthesize, optionally save a digest to the vault",
  details: `Usage:
  pi-agent cli research <natural-language query...> [options]
  pi-agent cli research <query...> --save [options]

Drives a web-research flow with the web-access tools:
  1. web_search   — multi-provider search (Z.ai / OpenAI / Brave / Exa / Tavily …)
  2. fetch_content — extract readable markdown from top URLs (incl. YouTube transcripts,
                    GitHub repos, PDFs, local video)
  3. get_search_content — retrieve full stored content from a prior search/fetch
  4. synthesize   — the agent writes a concise, cited answer (or digest)

With \`--save\`, the synthesized digest is written to the Obsidian vault via
the \`obsidian\` tool (action: "create") (pi-obsidian is baked into every CLI
session), so a web search becomes durable, searchable knowledge.

Positionals are the query verbatim. For multi-angle research, prefer a rich query
("compare X vs Y performance 2026") over a single term — the agent varies phrasing
internally for broader coverage.

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, gemma-4-12b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)
  --save                 write the synthesized digest to the vault (default: print only)

Examples:
  pi-agent cli research "RAG vs graph RAG benchmarks 2026"
  pi-agent cli --model sonnet research "Apple MLX vs PyTorch MPS performance" --save
  pi-agent cli research "explain the paper at https://arxiv.org/abs/2401.00001"`,
  factory: extension,
  tools: RESEARCH_TOOLS,
  task: (parsed) => {
    const query = parsed.positionals.join(" ").trim();
    // `parsed` is the full ParsedArgs at runtime (runner passes it through);
    // --save is declared in args.ts BOOLEAN_FLAGS as the `save` field.
    const save = (parsed as any).save === true;
    if (!query) {
      return "Use the web_search / fetch_content tools to help the user with web " +
        "research. Ask or infer what they want to learn, search with 2-4 varied " +
        "angles for broad coverage, then synthesize a concise cited answer.";
    }
    let task = "Research this query using the web_search and fetch_content tools. " +
      "Search with 2-4 varied phrasings/angles for broad coverage (each query gets " +
      "its own synthesized answer). Fetch full content from the most promising " +
      "sources via fetch_content. Then write a concise, well-cited synthesis.\n\n" +
      "Query:\n" + query;
    if (save) {
      task += "\n\nAfter synthesizing, save a durable digest note to the Obsidian " +
        "vault via the obsidian tool (action: \"create\"): a frontmatter'd markdown " +
        "note with the query as title, the synthesis as the body, and a '## Sources' " +
        "section listing the URLs cited. Use the obsidian tool (action: \"search\") " +
        "first to avoid duplicating an existing note.";
    }
    return task;
  },
};
