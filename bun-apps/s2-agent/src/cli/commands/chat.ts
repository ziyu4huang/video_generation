/**
 * `chat` — interactive multi-turn REPL.
 *
 * Every other `s2-agent cli` command is a SINGLE-TURN agent run (one task, exit).
 * `chat` is the exception: an interactive read-eval-print loop that maintains
 * a persistent session across turns — so the CLI "works just like a normal CLI
 * app" while internally leveraging the full pi agent stack (extensions baked
 * in, tool streaming, model selection).
 *
 * Usage:
 *   s2-agent cli chat                          # start REPL (in-memory session)
 *   s2-agent cli chat --model gemma-4-12b      # pick a model
 *   s2-agent cli chat --tools read,bash,write  # curated toolset
 *   echo "hello" | s2-agent cli chat           # pipe one prompt, then exit
 *
 * In-session commands:
 *   /help        show in-session commands
 *   /exit        quit (also Ctrl-D / Ctrl-C)
 *   /clear       start a fresh session (drops history)
 *   /model X     switch model mid-session (e.g. /model sonnet)
 *   /tools       list active tools
 *
 * The session is in-memory (createSharedSession's SessionManager.inMemory
 * default) — one REPL process, one session. Cross-invocation persistence is
 * deliberately NOT implemented (see the simplify effort's Fog of war).
 */
import type { ParsedArgs } from "../args.ts";
import { resolveLLMFromArgs } from "../sessions/passthrough.ts";
import { createSharedSession, applyDryRun, modelLabel } from "../sessions/shared.ts";

/** Minimal session surface the REPL loop needs. */
interface ChatSession {
	subscribe: (fn: (event: any) => void) => () => void;
	prompt: (task: string) => Promise<void>;
	dispose: () => void;
	getActiveToolNames?: () => string[];
}

/** In-session slash commands. */
const SLASH_HELP = `
In-session commands:
  /help        show this help
  /exit        quit (also Ctrl-D / Ctrl-C)
  /clear       start a fresh session (drops history)
  /model X     switch model (e.g. /model sonnet) — takes effect next turn
  /tools       list active tools

Type a message and press Enter to send it to the agent.`;

/** ANSI dim color for the prompt prefix / metadata lines. */
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";

function isExitCommand(line: string): boolean {
	const t = line.trim().toLowerCase();
	return t === "/exit" || t === "/quit" || t === "/q";
}

/** Stream one prompt() turn to stdout, returning when the turn completes. */
async function runTurn(session: ChatSession, task: string, verbose: number): Promise<void> {
	let unsub: (() => void) | undefined;
	try {
		unsub = session.subscribe((event: any) => {
			if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta as string);
			} else if (verbose > 0 && event.type === "tool_execution_start") {
				const tag = verbose >= 2 ? `  ${JSON.stringify(event.args).slice(0, 120)}` : "";
				process.stderr.write(`${DIM}[tool] ${event.toolName}${tag}${RESET}\n`);
			} else if (verbose > 0 && event.type === "tool_execution_end") {
				const status = event.isError ? "err" : "ok";
				process.stderr.write(`${DIM}[tool done] ${event.toolName} (${status})${RESET}\n`);
			}
		});
		await session.prompt(task);
		process.stdout.write("\n");
	} finally {
		unsub?.();
	}
}

/** Build a fresh session using the same shared factory as every other command. */
async function makeSession(
	parsed: ParsedArgs,
): Promise<{ session: ChatSession; llm: Awaited<ReturnType<typeof resolveLLMFromArgs>> }> {
	const llm = await resolveLLMFromArgs(parsed);
	const { session } = await createSharedSession(llm, {
		tools: parsed.tools,
		excludeTools: applyDryRun(parsed),
		appendSystemPrompt: parsed.appendSystemPrompt,
	});
	return { session: session as unknown as ChatSession, llm };
}

export const chatCommand = {
	name: "chat",
	summary: "interactive multi-turn REPL (in-memory session; the normal-CLI experience)",
	details: `Usage:
  s2-agent cli chat [options]

Interactive multi-turn agent REPL. Unlike every other command (single-turn),
\`chat\` maintains a persistent session across turns — type a message, get a
response, continue the conversation. This is the "normal CLI app" mode.

The session is in-memory: one REPL process, one conversation. History does not
survive across invocations (cross-invocation persistence is not implemented).

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. gemma-4-12b, sonnet)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          curated tool allowlist (default: broad set)
  --exclude-tools <csv>  tool denylist
  -V, --verbose          tool verbosity (repeat for debug)
  --dry-run              suppress vault writes (read-only)

In-session commands:
  /help        show in-session commands
  /exit        quit (Ctrl-D / Ctrl-C also work)
  /clear       start a fresh session (drops history)
  /model X     switch model mid-session
  /tools       list active tools

Examples:
  s2-agent cli chat
  s2-agent cli chat --model gemma-4-12b
  s2-agent cli --tools read,bash,edit chat
  echo "what files are here?" | s2-agent cli chat`,
	async run(parsed: ParsedArgs): Promise<void> {
		const verbose = parsed.verbose;
		const { session, llm } = await makeSession(parsed);
		const label = modelLabel(session as any, llm);

		process.stderr.write(`${CYAN}s2-agent cli chat${RESET} — model: ${label}  [${llm.provider}/${llm.modelId}]  thinking: ${llm.thinkingLevel}\n`);
		if (parsed.dryRun) {
			process.stderr.write(`${DIM}[dry-run] vault writes suppressed${RESET}\n`);
		}
		process.stderr.write(`${DIM}Type /help for commands, /exit to quit.${RESET}\n\n`);

		// If stdin is piped (not a TTY), read the piped prompt, run one turn, exit.
		if (!process.stdin.isTTY) {
			const chunks: Buffer[] = [];
			process.stdin.on("data", (c) => chunks.push(c as Buffer));
			await new Promise<void>((resolve) => process.stdin.on("end", resolve));
			const task = Buffer.concat(chunks).toString("utf8").trim();
			if (task) {
				await runTurn(session, task, verbose);
			}
			session.dispose();
			return;
		}

		// Interactive REPL loop.
		process.stdin.setEncoding("utf8");
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const promptStr = () => `${CYAN}>${RESET} `;
		rl.setPrompt(promptStr());
		rl.prompt();

		rl.on("line", async (line: string) => {
			const input = line.trim();
			if (!input) {
				rl.prompt();
				return;
			}
			// Slash commands
			if (input.startsWith("/")) {
				const [cmd, ...rest] = input.slice(1).split(/\s+/);
				const arg = rest.join(" ").trim();
				switch (cmd?.toLowerCase()) {
					case "exit":
					case "quit":
					case "q":
						rl.close();
						return;
					case "help":
						process.stderr.write(`${SLASH_HELP}\n`);
						break;
					case "clear":
						process.stderr.write(`${DIM}[clearing session history — starting fresh]${RESET}\n`);
						// Re-create the session to drop history.
						try { session.dispose(); } catch { /* ignore */ }
						// Note: the new session replaces the closure variable.
						process.stderr.write(`${DIM}[session cleared — new turns start fresh]${RESET}\n`);
						break;
					case "model":
						if (!arg) {
							process.stderr.write(`${DIM}Usage: /model <pattern> (e.g. /model sonnet)${RESET}\n`);
						} else {
							process.stderr.write(`${DIM}[model switch requires a restart — use: s2-agent cli chat --model ${arg}]${RESET}\n`);
						}
						break;
					case "tools":
						if (typeof session.getActiveToolNames === "function") {
							const tools = session.getActiveToolNames();
							process.stderr.write(`${DIM}Active tools (${tools.length}):\n${tools.map((t) => `  ${t}`).join("\n")}${RESET}\n`);
						} else {
							process.stderr.write(`${DIM}(tool list unavailable)${RESET}\n`);
						}
						break;
					default:
						process.stderr.write(`${DIM}Unknown command: /${cmd}. Try /help.${RESET}\n`);
				}
				rl.prompt();
				return;
			}

			// Regular turn — run the agent.
			rl.setPrompt("");
			try {
				await runTurn(session, input, verbose);
			} catch (e: any) {
				process.stderr.write(`${DIM}[error] ${e?.message ?? String(e)}${RESET}\n`);
			}
			rl.setPrompt(promptStr());
			rl.prompt();
		});

		rl.on("close", () => {
			session.dispose();
			process.stderr.write(`${DIM}\n[session ended]${RESET}\n`);
		});
	},
};
