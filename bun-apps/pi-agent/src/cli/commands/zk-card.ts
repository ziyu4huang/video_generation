/**
 * `zk-card <subcommand> ...` — CRUD operations for Zettelkasten notes
 * with built-in duplicate prevention and backlink safety checks.
 *
 * Subcommands:
 *   add <text|--file path>      Create — with 4-layer duplicate check
 *   find <query>                Read   — multi-strategy semantic search
 *   update <note> <text>        Update — smart merge, no repeated content
 *   remove <note>               Delete — backlink safety check first
 *   check                       Audit  — vault health (duplicates, orphans)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { ParsedArgs } from "../args.ts";
import { applyVaultEnv, resolveLLMFromArgs } from "../sessions/passthrough.ts";
import { createSharedSession, applyDryRun, modelLabel } from "../sessions/shared.ts";
import {
  ADD_TOOLS,
  CHECK_TASK,
  CHECK_TOOLS,
  FIND_TOOLS,
  REMOVE_TOOLS,
  UPDATE_TOOLS,
  buildAddTask,
  buildFindTask,
  buildRemoveTask,
  buildUpdateTask,
} from "@repo/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts";
import { runJsonTask, runPrettyTask } from "../sessions/task-runner.ts";

/** Resolve content from positional text or --file. */
function resolveContent(positionals: string[], file: string | undefined, cwd: string, sub: string): string {
  if (file) {
    const abs = isAbsolute(file) ? file : resolve(cwd, file);
    if (!existsSync(abs)) throw new Error(`--file not found: ${file} (resolved: ${abs})`);
    return readFileSync(abs, "utf8").trim();
  }
  const text = positionals.join(" ").trim();
  if (!text) throw new Error(`Usage: zk-card ${sub}`);
  return text;
}

/** Shared runner — same pattern as distill.ts. */
async function runKnowledgeTask(
  parsed: ParsedArgs,
  task: string,
  tools: string[],
  label: string,
): Promise<void> {
  applyVaultEnv(parsed);
  const llm = await resolveLLMFromArgs(parsed);
  const effectiveTools = parsed.tools ?? tools;

  const { session } = await createSharedSession(llm, {
    tools: effectiveTools,
    excludeTools: applyDryRun(parsed),
    appendSystemPrompt: parsed.appendSystemPrompt,
  });

  const mLabel = modelLabel(session, llm);
  console.error(`[zk-card ${label}]  model: ${mLabel}  thinking: ${llm.thinkingLevel}`);
  if (parsed.dryRun) {
    console.error("[dry-run] vault writes suppressed — write tools excluded (agent can read + plan only)");
  }
  console.error();

  const printMode = parsed.mode === "json";

  try {
    if (printMode) {
      await runJsonTask(session, task, parsed.verbose);
    } else {
      await runPrettyTask(session, task, `zk-card ${label}`, parsed.verbose);
    }
  } finally {
    session.dispose();
  }
}

const DETAILS = `Usage:
  pi-agent cli zk-card add <text>            Add a new Zettelkasten note (with duplicate check)
  pi-agent cli zk-card add --file <path>     Add from file content
  pi-agent cli zk-card find <query>          Search notes (multi-strategy)
  pi-agent cli zk-card update <note> <text>  Smart-merge content into an existing note
  pi-agent cli zk-card remove <note>         Safely delete a note (backlink check)
  pi-agent cli zk-card check                 Audit vault health

Subcommands:
  add       Create a new atomic note. Runs 4-layer duplicate check before writing.
            Use --force to bypass thresholds (records duplicate_candidates in frontmatter).
  find      Search vault using title fuzzy, tag, and body keyword strategies.
  update    Smart-merge new content into an existing note. Never duplicates sections.
  remove    Delete a note. Stops if backlinks exist; use --force to override.
  check     Audit for duplicates, orphans, dead links, and unlinked related notes.

Options (pi-aligned globals also apply):
  --file <path>           Read content from file instead of inline text (add)
  --force                 Bypass safety checks (add: duplicate threshold; remove: backlinks)
  --context-lines <n>     Context lines around matches in find output (default: 3)
  --no-context            Show titles only in find output (same as --context-lines 0)
  --limit <n>             Max results for find (default: 10)
  --folder <name>         Zettelkasten target folder (default: Zettelkasten)
  --vault <path>          Absolute path to the vault
  --vault-dir <name>      Vault folder name under cwd (default: vault)
  --model <pattern>       provider/id[:thinking]
  --provider <name>       Provider name
  --thinking <level>      off|minimal|low|medium|high|xhigh
  --mode json             NDJSON event stream
  -p, --print             Non-interactive one-shot

Examples:
  pi-agent cli zk-card add "Zettelkasten is a note-taking method"
  pi-agent cli zk-card add --file concept.txt
  pi-agent cli zk-card add "concept" --force
  pi-agent cli zk-card find "bun workspace"
  pi-agent cli zk-card find "LLM" --limit 5 --no-context
  pi-agent cli zk-card update Zettelkasten/Note.md "additional info"
  pi-agent cli zk-card remove Zettelkasten/Note.md
  pi-agent cli zk-card remove Zettelkasten/Note.md --force
  pi-agent cli zk-card check`;

export const zkCardCommand = {
  name: "zk-card",
  summary: "CRUD operations for Zettelkasten notes (add / find / update / remove / check)",
  details: DETAILS,
  async run(parsed: ParsedArgs): Promise<void> {
    const cwd = process.cwd();
    const [sub, ...rest] = parsed.positionals;
    const folder = parsed.folder ?? "Zettelkasten";

    switch (sub) {
      case "add": {
        const content = resolveContent(rest, parsed.file, cwd, "add <text|--file path>");
        const task = buildAddTask(content, folder, !!parsed.force);
        await runKnowledgeTask(parsed, task, ADD_TOOLS, "add");
        break;
      }

      case "find": {
        const query = rest.join(" ").trim();
        if (!query) throw new Error("Usage: zk-card find <query>");
        const contextLines = parsed.noContext ? 0 : (parsed.contextLines ?? 3);
        const limit = parsed.limit ?? 10;
        const task = buildFindTask(query, contextLines, limit);
        await runKnowledgeTask(parsed, task, FIND_TOOLS, "find");
        break;
      }

      case "update": {
        const [notePath, ...contentTokens] = rest;
        if (!notePath) throw new Error("Usage: zk-card update <note-path> <text|--file path>");
        const content = resolveContent(contentTokens, parsed.file, cwd, "update <note> <text|--file path>");
        const task = buildUpdateTask(notePath, content);
        await runKnowledgeTask(parsed, task, UPDATE_TOOLS, "update");
        break;
      }

      case "remove": {
        const [notePath] = rest;
        if (!notePath) throw new Error("Usage: zk-card remove <note-path>");
        const task = buildRemoveTask(notePath, !!parsed.force);
        await runKnowledgeTask(parsed, task, REMOVE_TOOLS, "remove");
        break;
      }

      case "check": {
        await runKnowledgeTask(parsed, CHECK_TASK, CHECK_TOOLS, "check");
        break;
      }

      default: {
        if (!sub) {
          console.log(DETAILS);
        } else {
          console.error(`Unknown zk-card subcommand: ${sub}`);
          console.error("Available: add, find, update, remove, check");
          process.exit(1);
        }
      }
    }
  },
};
