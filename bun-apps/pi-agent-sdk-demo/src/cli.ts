/**
 * Hierarchical sub-command registry for the CLI.
 *
 * Supports arbitrary nesting: each node may carry a `run()` (leaf action),
 * `subcommands` (branch), or both. Resolution walks argv, consuming tokens
 * that match a registered child name/alias; whatever remains is passed as
 * args to the deepest matched node.
 *
 *   root
 *   ├─ minimal   (agent one-shot)
 *   ├─ full      (agent one-shot)
 *   ├─ tools     (agent one-shot)
 *   ├─ ext       (agent one-shot)
 *   ├─ sub       (parent agent + subagent tool → delegates to isolated sessions)
 *   ├─ chat      (agent REPL)
 *   ├─ config    (branch)
 *   │  ├─ show      (print resolved shared LLM config)
 *   │  └─ models    (list available models)
 *   └─ agents    (branch)
 *      └─ list      (list discovered subagent definitions)
 *
 * Examples:
 *   bun src/cli.ts minimal "List files"
 *   bun src/cli.ts config show
 *   bun src/cli.ts config models
 */

// ---------- shared helpers (LLM-agnostic streaming) ----------

/** Stream assistant text deltas + tool activity to stdout. Returns unsubscribe. */
function attachStreamer(session: { subscribe: (fn: (e: any) => void) => () => void }) {
  return session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      console.log(`\n[tool] ${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      console.log(`[tool done] ${event.toolName} (${event.isError ? "err" : "ok"})`);
    }
  });
}

const DEFAULT_PROMPT = "What files are in the current directory? Be brief.";

/** Print the active model + thinking level for a session. */
function printModel(session: {
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
}) {
  const m = session.model;
  if (!m) {
    console.log("(no model selected)");
    return;
  }
  const label = m.name ? `${m.name}` : `${m.provider}/${m.id}`;
  console.log(`model: ${label}  [${m.provider}/${m.id}]  thinking: ${session.thinkingLevel ?? "?"}`);
}

/** Drive one user turn against a freshly-built session. */
async function runOneShot(build: () => Promise<any>, prompt: string) {
  const { session } = await build();
  printModel(session);
  console.log(`prompt: ${prompt}\n`);
  const unsub = attachStreamer(session);
  try {
    await session.prompt(prompt);
    console.log("\n--- done ---");
  } finally {
    unsub();
    session.dispose();
  }
}

// ---------- sub-command registry ----------
export interface CommandContext {
  /** Matched command path, e.g. ["config", "models"]. */
  path: string[];
  /** Leftover positional args after the path (flags stripped). */
  args: string[];
  /** Raw leftover args after the path, flags included (for sub-command parsing). */
  rawArgs: string[];
  /** Convenience: positional args joined into a prompt string. */
  prompt: string;
}

export interface Command {
  name: string;
  summary: string;
  /** Longer help shown with `<cmd> -h` (e.g. flag reference). */
  details?: string;
  aliases?: string[];
  /** True if the command talks to the LLM (runs preflight + needs a model). */
  agent?: boolean;
  /** Leaf action. */
  run?: (ctx: CommandContext) => void | Promise<void>;
  /** Nested commands. */
  subcommands?: Command[];
}

// --- agent sub-commands (shared LLM config via createSharedSession) ---

const minimalCmd: Command = {
  name: "minimal",
  summary: "all defaults — simplest shared-config one-shot",
  agent: true,
  async run(ctx) {
    const { createSharedSession } = await import("./sessions/shared.ts");
    await runOneShot(createSharedSession, ctx.prompt);
  },
};

const fullCmd: Command = {
  name: "full",
  summary: "explicit model from shared config, read-only tools",
  agent: true,
  async run(ctx) {
    const { buildFullControlSession } = await import("./sessions/full-control-session.ts");
    await runOneShot(buildFullControlSession, ctx.prompt);
  },
};

const toolsCmd: Command = {
  name: "tools",
  summary: "custom tool (get_uptime)",
  agent: true,
  async run(ctx) {
    const { buildCustomToolsSession } = await import("./sessions/custom-tools-session.ts");
    await runOneShot(buildCustomToolsSession, ctx.prompt);
  },
};

const extCmd: Command = {
  name: "ext",
  summary: "inline extension (events, bash gate, ping tool)",
  agent: true,
  async run(ctx) {
    const { buildInlineExtensionSession } = await import("./sessions/inline-extension-session.ts");
    await runOneShot(buildInlineExtensionSession, ctx.prompt);
  },
};

const chatCmd: Command = {
  name: "chat",
  summary:
    "interactive REPL (resume by default); -p/--print for non-interactive batch",
  details: `Flags:
  (default)                  interactive REPL — resume most recent session
  -p, --print "prompt"       non-interactive: one turn, stream reply, exit (persists)
  --mode json "prompt"       NDJSON event stream (for programmatic consumers)
  --no-session               in-memory session (no persistence) — for sub-agents
  --tools read,grep,find     restrict available tools
  --append-system-prompt F   inject file F as system prompt
  --idle-timeout <sec>       auto-exit after N seconds idle (default: 15; 0 disables)
  --no-idle-timeout          disable the idle auto-exit
  --new                      force a brand-new session
  -r, --resume               continue most recent session
  -s, --session <id>         resume a specific session
  --list                     list sessions for this directory

Piped stdin is merged into the prompt in print/json mode:
  echo "notes" | bun src/cli.ts chat -p "Summarize"

Interactive REPL: type a message + Enter; Ctrl+D or /exit to quit.`,
  agent: true,
  async run(ctx) {
    const { chatLoop } = await import("./sessions/chat-loop.ts");
    const flags = parseChatFlags(ctx.rawArgs);
    // Default 15s idle timeout for interactive REPL; 0 disables.
    if (flags.idleTimeoutMs === undefined && !flags.print && !flags.jsonMode) {
      flags.idleTimeoutMs = 15000;
    }
    await chatLoop(flags);
  },
};

export function parseChatFlags(args: string[]): import("./sessions/chat-loop.ts").ChatOptions {
  const out: import("./sessions/chat-loop.ts").ChatOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--new") out.new = true;
    else if (a === "-r" || a === "--resume") out.resume = true;
    else if (a === "--list") out.list = true;
    else if (a === "-p" || a === "--print") out.print = true;
    else if (a === "--mode") {
      const mode = args[++i];
      if (mode === "json") out.jsonMode = true;
    } else if (a.startsWith("--mode=")) {
      if (a.slice("--mode=".length) === "json") out.jsonMode = true;
    } else if (a === "--no-session") {
      out.noSession = true;
    } else if (a === "--tools") {
      out.tools = (args[++i] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    } else if (a.startsWith("--tools=")) {
      out.tools = a.slice("--tools=".length).split(",").map((t) => t.trim()).filter(Boolean);
    } else if (a === "--append-system-prompt") {
      out.appendSystemPrompt = args[++i];
    } else if (a.startsWith("--append-system-prompt=")) {
      out.appendSystemPrompt = a.slice("--append-system-prompt=".length);
    } else if (a === "--idle-timeout") {
      // seconds → ms
      out.idleTimeoutMs = (Number(args[++i]) || 0) * 1000;
    } else if (a.startsWith("--idle-timeout=")) {
      out.idleTimeoutMs = (Number(a.slice("--idle-timeout=".length)) || 0) * 1000;
    } else if (a === "--no-idle-timeout") {
      out.idleTimeoutMs = 0;
    } else if (a === "--session" || a === "-s") {
      out.sessionId = args[++i];
    } else if (a.startsWith("--session=")) {
      out.sessionId = a.slice("--session=".length);
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }
  if (positional.length) out.prompt = positional.join(" ");
  return out;
}

// --- `config` branch: demonstrates hierarchy ---

const configShowCmd: Command = {
  name: "show",
  summary: "print the resolved shared LLM config",
  async run() {
    const { LLM_CONFIG } = await import("./sessions/shared.ts");
    console.log("Resolved shared LLM config:");
    console.log(`  provider       ${LLM_CONFIG.provider}`);
    console.log(`  model          ${LLM_CONFIG.modelId}`);
    console.log(`  thinking       ${LLM_CONFIG.thinkingLevel}`);
    console.log(`  override via   PI_PROVIDER / PI_MODEL / PI_THINKING`);
  },
};

const configModelsCmd: Command = {
  name: "models",
  summary: "list models with valid credentials",
  async run() {
    const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const { LLM_CONFIG } = await import("./sessions/shared.ts");
    const auth = AuthStorage.create();
    const reg = ModelRegistry.create(auth);
    const available = await reg.getAvailable();
    console.log("Available models (with valid credentials):");
    for (const m of available) {
      const isDefault = m.provider === LLM_CONFIG.provider && m.id === LLM_CONFIG.modelId;
      console.log(`  - ${m.provider}/${m.id}${isDefault ? " (default)" : ""}`);
    }
    console.log(`\nTotal: ${available.length}`);
  },
};

// --- `version` leaf command ---

const versionCmd: Command = {
  name: "version",
  summary: "print the CLI version",
  async run() {
    printVersion();
  },
};

const configCmd: Command = {
  name: "config",
  summary: "inspect resolved configuration",
  subcommands: [configShowCmd, configModelsCmd],
};

// --- `sub` sub-command: parent agent with the subagent tool ---

const subCmd: Command = {
  name: "sub",
  summary: "parent agent with the `subagent` tool (delegates to isolated sessions)",
  agent: true,
  async run(ctx) {
    const { buildSubagentSession } = await import("./sessions/subagent-session.ts");
    await runOneShot(buildSubagentSession, ctx.prompt);
  },
};

// --- `agents` branch: inspect discovered subagent definitions ---

const agentsListCmd: Command = {
  name: "list",
  summary: "list discovered subagent definitions",
  async run() {
    const { discoverAgents } = await import("./subagent-tool.ts");
    const agents = discoverAgents(process.cwd());
    if (agents.length === 0) {
      console.log("No agents found.");
      console.log("  Define them in .pi/agents/*.md (project) or ~/.pi/agent/agents/*.md (user).");
      return;
    }
    console.log("Discovered agents (" + agents.length + "):\n");
    for (const a of agents) {
      const tag = "[" + a.source + "]";
      console.log("  " + a.name + "  " + tag + "  " + a.description);
      const meta: string[] = [];
      if (a.tools) meta.push("tools: " + a.tools.join(","));
      if (a.model) meta.push("model: " + a.model);
      if (meta.length) console.log("           " + meta.join("  "));
      console.log("           " + a.filePath);
    }
  },
};

const agentsCmd: Command = {
  name: "agents",
  summary: "inspect subagent definitions",
  subcommands: [agentsListCmd],
};

// --- root ---

export const ROOT: Command = {
  name: "pi-cli",
  summary: "pi-agent SDK demo",
  subcommands: [minimalCmd, fullCmd, toolsCmd, extCmd, subCmd, chatCmd, versionCmd, configCmd, agentsCmd],
};

// ---------- version ----------

async function readVersion(): Promise<string> {
  try {
    // One level up from src/ → the app's package.json.
    const pkg = await import("../package.json", { with: { type: "json" } as never });
    return (pkg.default ?? pkg)?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printVersion() {
  readVersion().then((v) => console.log(`pi-cli ${v}`));
}

// ---------- resolver ----------

export function findChild(node: Command, token: string): Command | undefined {
  return node.subcommands?.find(
    (c) => c.name === token || c.aliases?.includes(token),
  );
}

export function resolve(argv: string[]): { node: Command; path: string[]; args: string[] } {
  let node = ROOT;
  const path: string[] = [];
  const args = [...argv];
  while (args.length && !args[0].startsWith("-")) {
    const child = findChild(node, args[0]);
    if (!child) break;
    node = child;
    path.push(child.name);
    args.shift();
  }
  return { node, path, args };
}

// ---------- help ----------

function printHelp(node: Command, path: string[]) {
  const full = path.length ? `pi-cli ${path.join(" ")}` : "pi-cli";
  if (node.subcommands?.length) {
    const width = Math.max(...node.subcommands.map((c) => c.name.length));
    const lines = node.subcommands
      .map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
      .join("\n");
    console.log(`Usage: ${full} <subcommand> [args]\n\nSubcommands:\n${lines}\n\nRun "${full} <subcommand> -h" for details.`);
  } else {
    const detail = node.details ? `\n\n${node.details}\n` : "";
    console.log(`Usage: ${full} [args]\n\n${node.summary}${detail}`);
  }
}

// ---------- main dispatch ----------

async function main() {
  const argv = process.argv.slice(2);

  // Short-circuit --version / -v before any resolution.
  if (argv.length === 1 && (argv[0] === "-v" || argv[0] === "--version")) {
    printVersion();
    return;
  }

  // Strip help flags anywhere → render help for the deepest matched node.
  const helpRequested = argv.some((a) => a === "-h" || a === "--help" || a === "help");

  const { node, path, args } = resolve(argv);

  if (helpRequested || !node.run && !node.subcommands) {
    if (!node.run && !node.subcommands) {
      // matched nothing useful at root
      printHelp(ROOT, []);
      return;
    }
    printHelp(node, path);
    return;
  }

  // Preflight only for agent sub-commands.
  if (node.agent) {
    const { preflight } = await import("./preflight.ts");
    const diag = await preflight();
    diag.print();
    if (diag.warnings.some((w) => w.severity === "error")) {
      console.error("\nRefusing to run: blocking error detected above. Fix and retry.");
      process.exit(1);
    }
    console.error();
  }

  const ctx: CommandContext = {
    path,
    args: args.filter((a) => !a.startsWith("-")),
    rawArgs: args,
    prompt: args.filter((a) => !a.startsWith("-"))
      .join(" ")
      .trim() || DEFAULT_PROMPT,
  };

  // A branch node without a run() but with leftover args → show help.
  if (!node.run) {
    if (args.length === 0) {
      printHelp(node, path);
      return;
    }
    console.error(`Unknown subcommand: ${args[0]}\n`);
    printHelp(node, path);
    process.exit(1);
  }

  await node.run(ctx);
}

if (import.meta.main) {
  await main();
}
