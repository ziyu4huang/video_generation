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
 *   bun-pi-agent-cli agent "read the files in this dir and summarize"
 *   bun-pi-agent-cli agent --tools read,bash "list and explain the test files"
 *   bun-pi-agent-cli --model sonnet agent "refactor the doctor command"
 *
 * Default toolset (when --tools is not given) is the full READ + WRITE +
 * vault + web set. Pass --tools to narrow it. Pass --dry-run for read-only.
 */
import type { ParsedArgs } from "../args.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
// Extension factories for the broad toolset. obsidian is always baked in
// (shared.ts); these provide web_search/fetch_content (web-access) and
// zk_card/zk_ask/knowledge_query (knowledge-card).
import webAccessExtension from "@repo/pi-agent-ext-web-access";
import knowledgeCardExtension from "@repo/pi-agent-ext-knowledge-card/extensions/pi-knowledge-card.ts";
// Sub-agent orchestration — opt-in via --subagent (heavy schema: ~2800 tok).
import subagentsExtension from "@repo/pi-agent-ext-subagents/src/extension/index.ts";

/**
 * The broad default toolset for the `agent` command. This is the full palette
 * an autonomous agent needs: filesystem (read/write/bash/edit), vault access
 * (obsidian), web research (web_search/fetch), and knowledge (zk tools).
 *
 * Notably EXCLUDED by default: media generation (flux2/krea2/ltx — heavy
 * binaries, use the dedicated subcommands), subagent orchestration (use the
 * pi-agent TUI for multi-agent), and workflow (deterministic, use `workflow
 * run`). The user can always add them via --tools.
 */
const AGENT_TOOLS = [
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
  bun-pi-agent-cli agent <task...> [options]

Free-form single-turn agent run with a BROAD curated toolset. This is the
"agentic" entry point — give a natural-language task and the agent has full
autonomy over filesystem, vault, web, and knowledge tools.

Default tools (overridable with --tools):
${AGENT_TOOLS.map((t) => `  ${t}`).join("\n")}

Notably excluded by default (use the dedicated subcommands):
  flux2 / krea2 / ltx  — media generation (heavy binaries)
  subagent             — multi-agent orchestration (use pi-agent TUI)
  workflow             — deterministic engine (use 'workflow run')

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]
  --tools <csv>          override the curated toolset
  --exclude-tools <csv>  denylist
  --subagent             inject sub-agent orchestration tools (subagent, wait, help)
  -p, --print            non-interactive (already the default)
  --no-session           ephemeral (in-memory) session
  --mode json            NDJSON event stream
  -V, --verbose          tool verbosity (repeat for debug)
  --dry-run              suppress vault writes (read-only)

Examples:
  bun-pi-agent-cli agent "read package.json and explain the scripts"
  bun-pi-agent-cli agent "list all test files and summarize coverage"
  bun-pi-agent-cli --model sonnet agent "review the doctor command for bugs"
  bun-pi-agent-cli agent --tools read,bash,web_search "research bun workspaces"
  bun-pi-agent-cli agent --subagent "review this repo: one agent reads, one writes fixes"
  bun-pi-agent-cli agent --dry-run "plan a refactor of shared.ts"`,
	async run(parsed: ParsedArgs): Promise<void> {
		const task = parsed.positionals.join(" ").trim();
		if (!task) {
			console.error("No task given. Pass a natural-language task as positionals.");
			console.error("Example: bun-pi-agent-cli agent \"read the files in this dir\"");
			process.exit(1);
		}
		// --subagent: inject the subagents extension so the agent can delegate to
		// child agents (parallel fan-out, advisory review, etc.). The subagent
		// tool schema is ~2800 tok, so it's opt-in rather than a default.
		const withSubagent = parsed.rest.includes("--subagent");
		const factories: unknown[] = [
			webAccessExtension as unknown,
			knowledgeCardExtension as unknown,
			...(withSubagent ? [subagentsExtension as unknown] : []),
		];
		const tools = parsed.tools ?? [
			...AGENT_TOOLS,
			...(withSubagent ? ["subagent", "subagent_help", "wait"] : []),
		];
		await runAgentSession(parsed, {
			tools,
			task,
			labelName: "agent",
			factories,
		});
	},
};
