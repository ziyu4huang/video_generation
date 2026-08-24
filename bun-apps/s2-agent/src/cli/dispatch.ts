/**
 * s2-agent's non-interactive CLI — pi-obsidian baked in.
 *
 * NOT a process entry point. This module is reached only through s2-agent's
 * single binary, under the `cli` namespace token, via the exported `runCli()`
 * at the bottom of this file. `s2-agent` with no `cli` token still starts the
 * interactive TUI.
 *
 * Two invocation styles:
 *
 *   1. Agent commands (one CLI = one agent workflow):
 *        s2-agent cli file2md <files...> [options]       PDF/image → Obsidian md
 *        s2-agent cli zk-extract <files.../folders...> [options] markdown → Zettelkasten notes
 *        s2-agent cli zk-card <sub> [options]                 CRUD for Zettelkasten notes (add/find/update/remove/check)
 *        s2-agent cli zk-ask <question> [options]             graph-enhanced vault Q&A
 *        s2-agent cli zk-ingest <jsonl-files...> [options]    converge structured records → shared knowledge-graph vault
 *        s2-agent cli zk-query [options]                       cross-workflow retrieval + graph health (READ side)
 *        s2-agent cli pipeline pdf-to-vault <pdf> [options]   PDF → md → vault (resumable)
 *
 *      Plus meta commands: list | version | help.
 *
 *   2. Pi-compatible passthrough (anything else) — mirrors `pi -p` / `pi --mode json`:
 *        s2-agent cli --model sonnet -p "What files are here?"
 *        s2-agent cli --mode json -p --no-session --tools read,bash "task"
 *
 *      This is what the pi-obsidian `obsidian_distill` / `obsidian_garden`
 *      subagent tools re-invoke (process.argv[1] + pi flags). The `-e` /
 *      `--approve` flags are accepted and ignored (obsidian is always baked in).
 */
import { parsePiArgs } from "./args.ts";
import { zkExtractCommand } from "./commands/zk-extract.ts";
import { zkCardCommand } from "./commands/zk-card.ts";
import { zkAskCommand } from "./commands/zk-ask.ts";
import { zkIngestCommand } from "./commands/zk-ingest.ts";
import { zkQueryCommand } from "./commands/zk-query.ts";
import { file2mdCommand } from "./commands/file2md.ts";
import { pdfToVaultCommand } from "./commands/pdf-to-vault.ts";
import { imageToVaultCommand } from "./commands/image-to-vault.ts";
import { urlToVaultCommand, youtubeToVaultCommand } from "./commands/url-to-vault.ts";
import { knowledgePipelineCommand } from "./commands/knowledge-pipeline.ts";
import { memoryToVaultCommand } from "./commands/memory-to-vault.ts";
import { chatCommand } from "./commands/chat.ts";
import { agentCommand } from "./commands/agent.ts";
import { workflowRunCommand, workflowListCommand } from "./commands/workflow.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { toolsMetricsCommand } from "./commands/tools-metrics.ts";
import { agentTrendsCommand } from "./commands/agent-trends.ts";
import { sessionsCommand } from "./commands/sessions.ts";
import { memoryCommand } from "./commands/memory.ts";
import { loopCommand } from "./commands/loop.ts";
import { pipelineGateCommand } from "./commands/pipeline-gate.ts";
import { dispatchLogCommand } from "./commands/dispatch-log.ts";
import { printCompletions, completionsMeta } from "./commands/completions.ts";
import { printTable } from "./format.ts";
import { EXTENSION_COMMANDS } from "./extensions/registry.ts";
import { runPassthrough } from "./sessions/passthrough.ts";
import { bakedProviderConfigs } from "../pre-load-providers.ts";
import { publishSeam } from "@repo/s2-agent-core-interface";

const VERSION = "0.7.11";

/** A top-level agent/meta command. Exported for extensions/registry.ts. */
export interface Command {
  name: string;
  summary: string;
  details: string;
  run: (parsed: import("./args.ts").ParsedArgs) => Promise<void>;
}

/**
 * Top-level leaf commands (one CLI = one agent workflow).
 * Order = display order in `help`.
 */
const COMMANDS: Command[] = [
  chatCommand,
  agentCommand,
  file2mdCommand,
  zkExtractCommand,
  zkCardCommand,
  zkAskCommand,
  zkIngestCommand,
  zkQueryCommand,
  doctorCommand,
  toolsMetricsCommand,
  agentTrendsCommand,
  sessionsCommand,
  memoryCommand,
  loopCommand,
  pipelineGateCommand,
  dispatchLogCommand,
  // Extension-backed sub-commands (each = one workspace extension exporting an
  // ExtensionSubcommandSpec). See src/cli/extensions/registry.ts.
  ...EXTENSION_COMMANDS,
];

/**
 * `pipeline <name> <args>` — multi-stage orchestrators built from leaf commands.
 * Order = display order in `help`.
 */
const PIPELINES: Command[] = [
  pdfToVaultCommand,
  imageToVaultCommand,
  urlToVaultCommand,
  youtubeToVaultCommand,
  memoryToVaultCommand,
];

/**
 * `workflow <sub>` — headless runner for s2-agent-ext-ultracode engine scripts.
 * NOT an agent command: calls `runWorkflow()` directly (deterministic gates).
 * See commands/workflow.ts and `s2-agent cli workflow --help`.
 */
const WORKFLOWS: Command[] = [workflowRunCommand, workflowListCommand];

/** Meta commands (not agent workflows). */
const META = ["list", "list-tools", "completions", "version", "help"] as const;

/** Reserved tokens that must never be treated as a passthrough prompt. */
const RESERVED = new Set<string>([
  ...COMMANDS.map((c) => c.name),
  ...PIPELINES.map((c) => c.name),
  ...WORKFLOWS.map((c) => c.name),
  "pipeline", // namespace
  "workflow", // namespace
  ...META,
  // hidden alias kept for backward compatibility / muscle memory
  "oneshot",
]);

function isHelp(tok: string | undefined): boolean {
  return tok === "-h" || tok === "--help" || tok === "help";
}

/** Find a command by name within one of the groups (COMMANDS / PIPELINES / WORKFLOWS). */
function findIn(list: Command[], name: string): Command | undefined {
  return list.find((c) => c.name === name);
}

/** Print a message to stderr and exit non-zero. Consolidates the spread exit(1) sites. */
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printRootHelp(): void {
  const agentLines = COMMANDS.map(
    (c) => `  ${c.name.padEnd(14)} ${c.summary}`,
  ).join("\n");
  const pipelineLines = PIPELINES.map(
    (c) => `  ${c.name.padEnd(14)} ${c.summary}`,
  ).join("\n");
  const workflowLines = WORKFLOWS.map(
    (c) => `  ${c.name.padEnd(14)} ${c.summary}`,
  ).join("\n");

  console.log(`s2-agent cli v${VERSION} — s2-agent's non-interactive command namespace (pi-obsidian baked in)

Usage:
  s2-agent cli <command> [options]
  s2-agent cli pipeline <name> [options]   (multi-stage orchestrators)
  s2-agent cli workflow <sub> [options]    (headless engine runner)
  s2-agent cli [pi-compatible flags] [prompt]   (passthrough agent mode)

Commands (agents):
${agentLines}

Pipelines:
${pipelineLines}
  status / run /     knowledge pipeline: converge + merge + heal
  dry-run / lint     (pipeline status | run | dry-run | lint)

Workflow:
${workflowLines}

Meta:
  list                            List available models (with credentials)
  --list-models, -lm             Alias for the list command (pi-compatible)
  list-tools                      List registered tools (for --tools discovery)
  --list-tools, -lt              Alias for the list-tools command
  completions <shell>            Generate shell completions (bash | zsh | fish)
  version                         Print version
  help [command]                  Show help (root, or a command's details)

Pi-compatible flags (passthrough + global):
  --model <pattern>           "id", "provider/id", or "provider/id:thinking"
  --provider <name>           provider name
  --thinking <level>          off|minimal|low|medium|high|xhigh
  --api-key <key>             API key
  --mode <text|json>          output mode (default: text)
  -p, --print                 non-interactive one-shot
  -V, --verbose               tool verbosity: show args (repeat: -VV = debug)
  --debug                     alias for -VV (full args + result preview)
  --no-session                ephemeral (in-memory) session
  --tools, -t <csv>           tool allowlist
  --exclude-tools, -xt <csv>  tool denylist
  --append-system-prompt <x>  text or file path (repeatable)
  -e, --extension <path>      (ignored — obsidian baked in)
  -a, --approve               (ignored — self-trusted)
  --dry-run                   suppress vault writes (exclude write tools / skip fs)

Examples:
  s2-agent cli chat                                    # interactive REPL (normal-CLI mode)
  s2-agent cli chat --model gemma-4-12b                # pick a model for chat
  s2-agent cli agent "read package.json and explain"   # free-form agentic task
  s2-agent cli agent --tools read,bash "summarize"     # curated toolset
  s2-agent cli file2md paper.pdf
  s2-agent cli file2md scan.jpg --type image --extract ocr
  s2-agent cli zk-extract notes.md --folder Zettelkasten
  s2-agent cli zk-extract ./inbox/ --max-notes 20
  s2-agent cli pipeline pdf-to-vault paper.pdf
  s2-agent cli pipeline pdf-to-vault paper.pdf --pages 1-3 --delete-png
  s2-agent cli workflow run closed-loop-proof
  s2-agent cli workflow run closed-loop-proof --args '{"kbFile":"mlx-movie-director-self-improve"}' --dry-run
  s2-agent cli workflow list
  s2-agent cli zk-card add "concept text"
  s2-agent cli zk-card find "bun workspace"
  s2-agent cli zk-card update Zettelkasten/Note.md "new info"
  s2-agent cli zk-card remove Zettelkasten/Note.md
  s2-agent cli zk-card check
  s2-agent cli zk-ask "How does Bun handle workspaces?"
  s2-agent cli zk-ask "Zettelkasten atomic notes" --depth 3 --summarize
  s2-agent cli zk-ask "PDF pipeline" --retrieve-only
  s2-agent cli -p "List files in the current directory"
  s2-agent cli --mode json -p --no-session --tools read,bash "summarize"
  s2-agent cli list

Environment:
  PI_PROVIDER / PI_MODEL / PI_THINKING   LLM overrides
  OB_VAULT_PATH / OB_VAULT_DIR           vault resolution (obsidian)
  OB_SUBAGENT_TIMEOUT_MS                 zk-extract subagent timeout (default 300000)
  PI_VERBOSE                             0|1|2 verbosity (same as -V/--verbose/--debug)`);
}

/** Format a token count as a compact human string: 1000000 → "1M", 16384 → "16.4K", 128000 → "128K". */
function humanizeTokens(n: number | undefined): string {
  if (!n || !Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")) + "M";
  }
  if (n >= 1000) {
    const k = n / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)) + "K";
  }
  return String(Math.round(n));
}

/**
 * Print the model table (pi `--list-models` style):
 *   provider  model  context  max-out  thinking  images
 */
async function listModels(): Promise<void> {
  const { getSharedServices, allModels } = await import("./sessions/shared.ts");
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const { services } = await getSharedServices();

  // Show ALL registered models (global → repo-local → baked-in), so the user
  // sees everything available to the CLI regardless of credential state.
  const rows = allModels(new ModelRegistry(services.modelRuntime)).map((m: any) => ({
    provider: String(m.provider ?? ""),
    model: String(m.id ?? ""),
    context: humanizeTokens(m.contextWindow),
    maxOut: humanizeTokens(m.maxTokens),
    thinking: m.reasoning ? "yes" : "no",
    images: Array.isArray(m.input) && m.input.includes("image") ? "yes" : "no",
  }));

  if (rows.length === 0) {
    console.log("No models registered.");
    console.log("Add providers via ~/.pi/agent/models.json or .pi/agent/models.json.");
    return;
  }

  printTable(rows, [
    { key: "provider", label: "provider" },
    { key: "model", label: "model" },
    { key: "context", label: "context" },
    { key: "maxOut", label: "max-out" },
    { key: "thinking", label: "thinking" },
    { key: "images", label: "images" },
  ]);
  console.log(`\nTotal: ${rows.length}`);
}

/**
 * Print all registered tools (for `--list-tools` / `list-tools`) as a flat
 * table: tool / source / description. Mirrors `listModels`'s altitude so users
 * can discover valid tool names before passing `--tools`.
 */
async function listTools(): Promise<void> {
  const { listRegisteredTools } = await import("./sessions/shared.ts");
  const tools = await listRegisteredTools();
  if (!tools.length) {
    console.log("No tools registered.");
    return;
  }

  // Defensive field access — ToolInfo shape is generated/untyped here.
  const clip = (s: string, max: number): string =>
    s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
  const rows = tools
    .map((t: any) => ({
      name: String(t?.name ?? ""),
      source: String(t?.source ?? t?.extensionName ?? t?.extension ?? t?.packageName ?? "(builtin)"),
      description: clip(String(t?.description ?? "").replace(/\s+/g, " ").trim(), 60),
    }))
    .filter((r) => r.name)
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));

  printTable(rows, [
    { key: "name", label: "tool" },
    { key: "source", label: "source" },
    { key: "description", label: "description" },
  ]);
  console.log(`\nTotal: ${rows.length}`);
}

/** Strip a leading `oneshot` prefix (backward-compat alias) if present. */
function stripOneshotAlias(argv: string[]): string[] {
  if (argv[0] === "oneshot") return argv.slice(1);
  return argv;
}

/** Drop the tokens at the given indices (any order) from argv. */
function withoutIndices(argv: string[], indices: number[]): string[] {
  const drop = new Set(indices);
  return argv.filter((_, i) => !drop.has(i));
}

/**
 * Resolve the sub-command token in argv: the FIRST positional token (value
 * flags and their values are skipped) when it is a reserved command name.
 *
 * Returns `{ name, index }` so callers can strip the command token while
 * preserving any global flags that preceded it (e.g. `--model X file2md …`
 * → command `file2md` at index 2). Returns undefined for passthrough-only
 * argv (no positional, or first positional is not a reserved command).
 *
 * Only the FIRST positional is considered, so a reserved word appearing later
 * (e.g. `-p "file2md"` as a prompt) does not trigger command dispatch.
 */
export function findCommandToken(argv: string[]): { name: string; index: number } | undefined {
  const { positionalIndices, positionals } = parsePiArgs(argv);
  const index = positionalIndices[0];
  if (index === undefined) return undefined;
  const name = positionals[0]!;
  return RESERVED.has(name) ? { name, index } : undefined;
}

async function runAgentCommand(cmd: Command, rest: string[]): Promise<void> {
  const parsed = parsePiArgs(rest);
  if (isHelp(rest[0]) || parsed.help) {
    console.log(cmd.details);
    return;
  }
  await cmd.run(parsed);
}

/**
 * The CLI's own dispatch. `argv` is everything AFTER the `cli` namespace token
 * — `s2-agent cli zk-ask "x"` reaches this as ["zk-ask", "x"].
 */
async function dispatch(argv: string[]): Promise<void> {
  // --version / -v anywhere at root short-circuits.
  if (argv.length === 1 && (argv[0] === "-v" || argv[0] === "--version")) {
    console.log(`s2-agent cli ${VERSION}`);
    return;
  }

  const stripped = stripOneshotAlias(argv);

  // --list-models anywhere at root short-circuits (pi-compatible flag).
  if (stripped.some((a) => a === "--list-models" || a === "-lm")) {
    await listModels();
    return;
  }

  // --list-tools anywhere at root short-circuits (discover valid tool names).
  if (stripped.some((a) => a === "--list-tools" || a === "-lt")) {
    await listTools();
    return;
  }

  // No args / bare help → root help.
  if (stripped.length === 0 || (stripped.length === 1 && isHelp(stripped[0]))) {
    printRootHelp();
    return;
  }

  // `help [target]` / `-h [target]` / `--help [target]` → show help for the
  // target (or root help), and NEVER dispatch. A leading help token is consumed
  // by parsePiArgs as the --help boolean flag, so without this guard the NEXT
  // positional dispatches as a command. COMMANDS/PIPELINES/WORKFLOWS happened to
  // print help (runAgentCommand checks parsed.help), but META commands
  // (version/list/list-tools/completions) have explicit `if (first === "X")`
  // branches that don't check the help flag → they EXECUTED instead of helping.
  // Documented contract: `help [command]  Show help (root, or a command's
  // details)`. (Known limit: `--model x help list` — help mid-argv — still
  // dispatches; that form is undocumented and rare.)
  if (isHelp(stripped[0])) {
    const helpProbe = parsePiArgs(stripped);
    const target = helpProbe.positionals[0];
    const cmd = target
      ? (findIn(COMMANDS, target) ?? findIn(PIPELINES, target) ?? findIn(WORKFLOWS, target))
      : undefined;
    if (cmd) {
      console.log(cmd.details);
    } else if (target === "pipeline") {
      const pname = helpProbe.positionals[1];
      const pcmd = pname ? findIn(PIPELINES, pname) : undefined;
      if (pcmd) console.log(pcmd.details);
      else console.log("Pipelines:\n" + PIPELINES.map((c) => `  ${c.name}`).join("\n"));
    } else if (target === "workflow") {
      const wname = helpProbe.positionals[1];
      const wcmd = wname ? findIn(WORKFLOWS, wname) : undefined;
      if (wcmd) console.log(wcmd.details);
      else console.log("Workflow sub-commands:\n" + WORKFLOWS.map((c) => `  ${c.name}`).join("\n"));
    } else {
      printRootHelp();
    }
    return;
  }

  // Detect the sub-command as the first POSITIONAL token, so global flags may
  // precede it — e.g. `--model X file2md file.pdf`. Without this, a leading
  // `--model` made stripped[0] a flag, so dispatch fell through to passthrough
  // and the command name was fed to the agent as a prompt.
  const found = findCommandToken(stripped);

  // Agent commands: s2-agent cli [global flags] <command> ...
  if (found) {
    const first = found.name;
    const cmdIdx = found.index;
    // argv with the command token removed; leading global flags now flow into
    // the command's own parsePiArgs call (so --model/--provider/etc. apply).
    const rest = withoutIndices(stripped, [cmdIdx]);
    // Deeper positionals (help target / pipeline name) — re-probe the full argv.
    const probe = parsePiArgs(stripped);

    if (first === "version") {
      console.log(`s2-agent cli ${VERSION}`);
      return;
    }

    if (first === "list") {
      await listModels();
      return;
    }

    if (first === "list-tools") {
      await listTools();
      return;
    }

    // `completions <shell>` — handled inline (needs COMMANDS/PIPELINES directly
    // to avoid a circular-import hang; see commands/completions.ts).
    if (first === "completions") {
      const shell = probe.positionals[1];
      if (!shell) {
        die(`Usage: completions <bash|zsh|fish>\n\n${completionsMeta.details}`);
      }
      try {
        printCompletions(
          shell,
          COMMANDS.map((c) => c.name),
          PIPELINES.map((c) => c.name),
        );
      } catch (e: any) {
        die(`error: ${e?.message ?? String(e)}`);
      }
      return;
    }

    // `pipeline <name> ...` namespace
    if (first === "pipeline") {
      const pname = probe.positionals[1];
      // Knowledge-pipeline sub-commands: pipeline status / run / dry-run / lint.
      // These are the ONE operational surface for the knowledge flow.
      const KP_SUBS = new Set(["status", "run", "dry-run", "lint"]);
      if (pname && KP_SUBS.has(pname)) {
        // Keep the sub-command as positionals[0]; only strip the `pipeline` token.
        await runAgentCommand(knowledgePipelineCommand, withoutIndices(stripped, [cmdIdx]));
        return;
      }
      if (!pname) {
        die(
          "Usage: pipeline <name> [options]\n\nAvailable pipelines:\n" +
            PIPELINES.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n"),
        );
      }
      const pcmd = findIn(PIPELINES, pname);
      if (!pcmd) {
        die(
          `Unknown pipeline: ${pname}\n\nAvailable: ` +
            PIPELINES.map((c) => c.name).join(", "),
        );
      }
      // drop both the `pipeline` namespace token and the pipeline-name token
      const pipeIdx = probe.positionalIndices[1]!;
      await runAgentCommand(pcmd, withoutIndices(stripped, [cmdIdx, pipeIdx]));
      return;
    }

    // `workflow <sub> ...` namespace (run | list). NOT an agent command — the
    // `run` sub-command calls runWorkflow() directly against the engine.
    if (first === "workflow") {
      const wname = probe.positionals[1];
      if (!wname) {
        die(
          "Usage: workflow <sub> [options]\n\nWorkflow sub-commands:\n" +
            WORKFLOWS.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n"),
        );
      }
      const wcmd = findIn(WORKFLOWS, wname);
      if (!wcmd) {
        die(
          `Unknown workflow sub-command: ${wname}\n\nAvailable: ` +
            WORKFLOWS.map((c) => c.name).join(", "),
        );
      }
      // drop both the `workflow` namespace token and the sub-command token.
      const wsubIdx = probe.positionalIndices[1]!;
      await runAgentCommand(wcmd, withoutIndices(stripped, [cmdIdx, wsubIdx]));
      return;
    }

    // otherwise it's a registered agent command
    const cmd = findIn(COMMANDS, first);
    if (cmd) {
      await runAgentCommand(cmd, rest);
      return;
    }
  }

  // Otherwise: pi-compatible passthrough.
  const parsed = parsePiArgs(argv);
  if (parsed.version) {
    console.log(`s2-agent cli ${VERSION}`);
    return;
  }
  if (parsed.help) {
    printRootHelp();
    return;
  }
  await runPassthrough(parsed);
}

/**
 * Run the non-interactive CLI and return its exit code.
 *
 * Called only from src/cli.ts's `cli` intercept — this module has no
 * `import.meta.main` entry any more, and must not gain one: it is reached
 * exclusively through s2-agent's single binary.
 */
export async function runCli(argv: string[]): Promise<number> {
  // Tell s2-agent-ext-subagent's getPiInvocation() to re-enter the `cli`
  // namespace when it spawns a child from process.argv[1]. Without this the
  // child lands on the TUI root and inherits the full static-extension set
  // this entry deliberately does not load (docs/adr/0002).
  process.env.PI_SELF_ENTRY_PREFIX = "cli";
  // Publish the baked provider catalog on the __piBakedProviders seam BEFORE
  // any command runs: this namespace dispatches before applyPatches (ADR
  // 0001), so the ModelRuntime.create wrap never runs here, and commands
  // that never build the shared session registry (e.g. `file2md`, which runs
  // the pipeline directly) would otherwise leave core-runtime's subagent
  // registry blind to baked-only lanes — every spawn of
  // lm-studio/prism-ml/bonsai-27b silently fell back to the session default
  // and produced EMPTY vision output (measured 2026-08-24). One catalog,
  // authored in src/pre-load-providers.ts; the patch file publishes the same
  // payload for the TUI/headless path.
  publishSeam("__piBakedProviders", bakedProviderConfigs());
  try {
    await dispatch(argv);
    // Honour the `process.exitCode = 1` convention used by doctor / zk-query,
    // which report failure WITHOUT throwing. Returning a hardcoded
    // 0 here would be clobbered onto the caller's `process.exit(0)` and silently
    // turn those documented failures into successes.
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e: any) {
    // Graceful failure for any thrown command error (bad input, invalid flags,
    // etc.): print a clean one-liner instead of dumping a stack trace.
    console.error(`error: ${e?.message ?? String(e)}`);
    return 1;
  }
}
