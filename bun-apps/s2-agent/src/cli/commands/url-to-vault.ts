/**
 * `pipeline url-to-vault <url>` and `pipeline youtube-to-vault <url>` —
 * URL → markdown → Zettelkasten vault.
 *
 * Unlike pdf-to-vault (deterministic: file2md + distill called directly),
 * these are **agent-driven**: fetching web content is a pi tool (`fetch_content`),
 * not a standalone function. So we run ONE agent session with both
 * `fetch_content` (web-access) and `obsidian` (pi-obsidian, baked in),
 * giving the agent a task that orchestrates: fetch the URL → save markdown →
 * distill into the vault.
 *
 * `youtube-to-vault` is a specialization: `fetch_content` already extracts
 * YouTube transcripts (with an optional user question/prompt via --vlm-model's
 * prompt param), so the task prompt is YouTube-specific. The URL is
 * auto-detected, so `url-to-vault` on a YouTube URL would also work — this just
 * gives the agent a clearer, YouTube-optimized task.
 */
import type { ParsedArgs } from "../args.ts";
import { applyVaultEnv } from "../vault-paths.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
import webAccessExtension from "@repo/s2-agent-ext-web-access";
import { ADD_TOOLS } from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";

/**
 * Tools needed: fetch (web-access) + the obsidian facade (pi-obsidian, baked in).
 *
 * `ADD_TOOLS` is knowledge-card's shared allowlist for vault-writing flows —
 * reusing it is what keeps this command from drifting the next time obsidian's
 * tool surface changes. It previously named `obsidian_distill` / `obsidian_create`
 * / `obsidian_search`, which stopped being registered tools when pi-obsidian
 * collapsed its 18 `obsidian_*` tools into one action-dispatched facade; only
 * `obsidian` and `obsidian_help` reach `pi.registerTool()`. Every run then died
 * at session creation on `validateToolNames`.
 */
export const URL_TO_VAULT_TOOLS = ["fetch_content", ...ADD_TOOLS];

/**
 * `fetch_content` lives in the web-access extension, which is NOT one of the
 * always-on factories `createSharedSession` bakes in (only pi-obsidian is), so
 * it has to be injected explicitly — same as `commands/agent.ts` does.
 */
export const URL_TO_VAULT_FACTORIES: unknown[] = [webAccessExtension as unknown];

/** Shared runner for both url/youtube → vault. */
async function runUrlToVault(
	parsed: ParsedArgs,
	opts: { label: string; isYouTube: boolean },
): Promise<void> {
	applyVaultEnv(parsed);
	const url = parsed.positionals[0];
	if (!url) {
		const kind = opts.isYouTube ? "YouTube URL" : "URL";
		throw new Error(`No ${kind} given. Usage: pipeline ${opts.label} <${kind}>`);
	}

	// The user's question/prompt (positionals[1..]) is forwarded to fetch_content
	// for YouTube (it directs the VLM to focus on specific aspects). For regular
	// URLs it's ignored (full content extraction is the goal).
	const userQuestion = parsed.positionals.slice(1).join(" ").trim();

	const folder = parsed.folder ?? "Zettelkasten";
	const maxNotes = parsed.maxNotes;

	let task: string;
	if (opts.isYouTube) {
		task =
			`Fetch the YouTube video content using the fetch_content tool:\n` +
			`  url: ${url}\n` +
			(userQuestion ? `  prompt: "${userQuestion}"\n` : "") +
			`\nThis returns the video transcript + metadata as markdown. Then distill ` +
			`that markdown into atomic Zettelkasten notes using the obsidian tool with ` +
			`action: "distill". Target folder: ${folder}.` +
			(maxNotes ? ` Max ~${maxNotes} notes (quality over quantity).` : "") +
			`\n\nAfter distill, report how many notes were created and list their titles.`;
	} else {
		task =
			`Fetch the web page content using the fetch_content tool:\n` +
			`  url: ${url}\n` +
			`\nThis returns the page's readable content as markdown. Then distill ` +
			`that markdown into atomic Zettelkasten notes using the obsidian tool with ` +
			`action: "distill". Target folder: ${folder}.` +
			(maxNotes ? ` Max ~${maxNotes} notes (quality over quantity).` : "") +
			`\n\nIf the page is very long, distill in logical sections. ` +
			`After distill, report how many notes were created and list their titles.`;
	}

	await runAgentSession(parsed, {
		tools: parsed.tools ?? URL_TO_VAULT_TOOLS,
		task,
		labelName: opts.label,
		factories: URL_TO_VAULT_FACTORIES,
	});
}

export const urlToVaultCommand = {
	name: "url-to-vault",
	summary: "web URL → markdown → Zettelkasten vault (fetch + distill, agent-driven)",
	details: `Usage:
  s2-agent cli pipeline url-to-vault <url> [options]

Runs an agent-driven two-step flow:
  1. fetch_content            — extract readable markdown from the URL
  2. obsidian action:"distill" — decompose the markdown into atomic Zettelkasten notes

Works on articles, blog posts, documentation pages, GitHub repos, and PDFs.
For YouTube videos, use \`pipeline youtube-to-vault\` instead (YouTube-optimized).

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (distill model)
  --folder <name>        vault target folder (default: Zettelkasten)
  --max-notes <n>        hint: cap notes produced (quality over quantity)
  --vault <path>         absolute vault path (sets OB_VAULT_PATH)
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  s2-agent cli pipeline url-to-vault https://example.com/article
  s2-agent cli pipeline url-to-vault https://arxiv.org/abs/2401.00001 --max-notes 15
  s2-agent cli --model bonsai-27b pipeline url-to-vault https://blog.example.com/post`,

	async run(parsed: ParsedArgs): Promise<void> {
		await runUrlToVault(parsed, { label: "url-to-vault", isYouTube: false });
	},
};

export const youtubeToVaultCommand = {
	name: "youtube-to-vault",
	summary: "YouTube video → transcript markdown → Zettelkasten vault (agent-driven)",
	details: `Usage:
  s2-agent cli pipeline youtube-to-vault <url> [question] [options]

Runs an agent-driven two-step flow:
  1. fetch_content  — extract the YouTube transcript + metadata as markdown.
     Pass an optional [question] positional to direct the VLM to focus on
     specific aspects of the video (e.g. "what tools are recommended?").
  2. obsidian action:"distill" — decompose the transcript into atomic Zettelkasten notes.

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (distill model)
  --folder <name>        vault target folder (default: Zettelkasten)
  --max-notes <n>        hint: cap notes produced (quality over quantity)
  --vault <path>         absolute vault path (sets OB_VAULT_PATH)
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  s2-agent cli pipeline youtube-to-vault https://youtube.com/watch?v=XXXX
  s2-agent cli pipeline youtube-to-vault https://youtu.be/XXXX "what frameworks are compared?"
  s2-agent cli pipeline youtube-to-vault https://youtube.com/watch?v=XXXX --max-notes 10`,

	async run(parsed: ParsedArgs): Promise<void> {
		await runUrlToVault(parsed, { label: "youtube-to-vault", isYouTube: true });
	},
};
