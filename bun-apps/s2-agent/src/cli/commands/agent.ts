/**
 * `agent` — free-form single-turn agent with a broad curated toolset.
 *
 * The "agentic" entry point: pass a natural-language task, the agent gets a
 * BROAD set of tools (read/write/bash/edit + obsidian vault + web + knowledge)
 * and full autonomy to use them. This is the single command that "fully
 * leverages pi agent capability" — every other command curates a NARROW
 * toolset for its specific workflow.
 *
 * Usage:
 *   s2-agent cli agent "read the files in this dir and summarize"
 *   s2-agent cli agent --tools read,bash "list and explain the test files"
 *   s2-agent cli --model sonnet agent "refactor the doctor command"
 *
 * Default toolset (when --tools is not given) is the full READ + WRITE +
 * vault + web set. Pass --tools to narrow it. Pass --dry-run for read-only.
 */
import type { ParsedArgs } from "../args.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
// Extension factories for the broad toolset. obsidian is always baked in
// (shared.ts); these provide web_search/fetch_content (web-access) and
// zk_card/zk_ask/knowledge_query (knowledge-card).
import webAccessExtension from "@repo/s2-agent-ext-web-access";
import knowledgeCardExtension from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";

/**
 * The broad default toolset for the `agent` command. This is the full palette
 * an autonomous agent needs: filesystem (read/write/bash/edit), vault access
 * (obsidian), web research (web_search/fetch), and knowledge (zk tools).
 *
 * Notably EXCLUDED by default: media generation (flux2/krea2/ltx — heavy
 * binaries, use the dedicated subcommands), and workflow (deterministic, use
 * `workflow run`). The user can always add them via --tools.
 */
export const AGENT_TOOLS = [
	// filesystem
	"read",
	"write",
	"edit",
	"bash",
	// vault (obsidian)
	"obsidian",
	// web
	"web_search",
	"fetch_content",
	// knowledge
	"zk_card",
	"zk_ask",
	"knowledge_query",
] as const;

export const agentCommand = {
	name: "agent",
	summary: "free-form agentic task with a broad toolset (read/write/bash/vault/web/knowledge)",
	details: `Usage:
  s2-agent cli agent <task...> [options]

Free-form single-turn agent run with a BROAD curated toolset. This is the
"agentic" entry point — give a natural-language task and the agent has full
autonomy over filesystem, vault, web, and knowledge tools.

Default tools (overridable with --tools):
${AGENT_TOOLS.map((t) => `  ${t}`).join("\n")}

Notably excluded by default (use the dedicated subcommands):
  flux2 / krea2 / ltx  — media generation (heavy binaries)
  workflow             — deterministic engine (use 'workflow run')

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]
  --tools <csv>          override the curated toolset
  --exclude-tools <csv>  denylist
  -p, --print            non-interactive (already the default)
  --no-session           ephemeral (in-memory) session
  --mode json            NDJSON event stream
  -V, --verbose          tool verbosity (repeat for debug)
  --dry-run              suppress vault writes (read-only)

Examples:
  s2-agent cli agent "read package.json and explain the scripts"
  s2-agent cli agent "list all test files and summarize coverage"
  s2-agent cli --model sonnet agent "review the doctor command for bugs"
  s2-agent cli agent --tools read,bash,web_search "research bun workspaces"
  s2-agent cli agent --dry-run "plan a refactor of shared.ts"`,
	async run(parsed: ParsedArgs): Promise<void> {
		const task = parsed.positionals.join(" ").trim();
		if (!task) {
			console.error("No task given. Pass a natural-language task as positionals.");
			console.error("Example: s2-agent cli agent \"read the files in this dir\"");
			process.exit(1);
		}
		const factories: unknown[] = [
			webAccessExtension as unknown,
			knowledgeCardExtension as unknown,
		];
		const tools = parsed.tools ?? [...AGENT_TOOLS];
		await runAgentSession(parsed, {
			tools,
			task,
			labelName: "agent",
			factories,
		});
	},
};
