/**
 * `zk-ask <question>` — Graph-enhanced RAG over the Zettelkasten vault.
 *
 * INVARIANT (thin shells): the 5 `zk-*` commands (`src/cli/commands/zk-*.ts`)
 * are thin shells over `s2-agent-ext-knowledge-card` — all logic (task
 * builders, deterministic ingest/retrieve/merge) lives there; these commands
 * only parse args + wire a single-turn agent run. CLI and extension never
 * drift because they import the same builders.
 *
 * Pipeline (single agent session):
 *   1. Seed retrieval  — 3-strategy search (same tools as zk-card find)
 *   2. Graph expansion — obsidian action:"search" graph:"neighbors" N-hop, per-seed cap
 *   3. Cluster & rank  — deterministic score (search_score + link_count), take top-K
 *   4. Context assembly — obsidian action:"read" each note; optional per-cluster summary
 *   5. Generate        — LLM answers question with assembled context
 *                        (--retrieve-only skips generation, shows context only)
 */

import type { ParsedArgs } from "../args.ts";
import { applyVaultEnv } from "../vault-paths.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
import { buildRagTask, RAG_TOOLS } from "@repo/s2-agent-ext-knowledge-card/extensions/knowledge-card.ts";

const DETAILS = `Ask a natural language question; returns a synthesized answer grounded in vault notes.

Usage:
  s2-agent cli zk-ask <question>
  s2-agent cli zk-ask <question> --retrieve-only

When to use:
  zk-ask      — you need a synthesized prose answer to a question ("How does X work?",
                "What is the relationship between A and B?")
  zk-card find — you need to locate specific notes or raw content by keyword
  zk-card check — you need to verify vault health / list all notes

Output:
  Default:         prose answer in zh-TW, grounded in vault notes, followed by a
                   reference list of source notes (title + path + reason for inclusion)
  --retrieve-only: structured context only (title, path, content per note); no generation

How it works internally:
  1. Seed retrieval   — title fuzzy + tag + body keyword search (3 strategies)
                        + seed quality gate: auto-rewrites query if top seed score < 0.4
  2. Graph expansion  — follows [[wikilinks]] outward from seeds (N-hop, capped per seed)
  3. Cluster & rank   — score = 0.7×search_score + 0.3×link_count; select top-K by tag
  4. Context assembly — full read for top-3 / score≥0.7 notes; snippet only for the rest
  5. Generate         — LLM answers the question grounded in assembled context

Options:
  --depth <n>            Graph hop depth for neighbor expansion (default: 2)
  --max-neighbors <n>    Max neighbor nodes per seed per hop (default: 5)
  --top-k <n>            Max notes to include in context (default: 8)
  --max-note-tokens <n>  Max tokens per note in full-read tier (default: 2000)
  --summarize            Summarize each tag cluster before generating
  --retrieve-only        Output assembled context only (no generation step)
  --no-refine            Skip seed quality gate (no query rewrite on poor seeds)
  --folder <name>        Restrict seed search to folder (default: Zettelkasten)
  --vault <path>         Absolute path to the vault
  --vault-dir <name>     Vault folder name under cwd (default: vault)
  --model <pattern>      provider/id[:thinking]
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --mode json            NDJSON event stream
  -p, --print            Non-interactive one-shot

Examples:
  s2-agent cli zk-ask "How does Bun handle workspaces?"
  s2-agent cli zk-ask "What is the relationship between Zettelkasten and atomic notes?" --depth 3
  s2-agent cli zk-ask "PDF processing pipeline" --summarize
  s2-agent cli zk-ask "LLM tool use patterns" --retrieve-only
  s2-agent cli zk-ask "atomic notes" --depth 1 --max-neighbors 3 --top-k 5`;

export const zkAskCommand = {
  name: "zk-ask",
  summary: "Ask a natural language question; returns a synthesized answer grounded in vault notes",
  details: DETAILS,
  async run(parsed: ParsedArgs): Promise<void> {
    const query = parsed.positionals.join(" ").trim();
    if (!query) {
      console.log(DETAILS);
      return;
    }

    const depth = parsed.depth ?? 2;
    const topK = parsed.topK ?? 8;
    const summarize = !!parsed.summarize;
    const retrieveOnly = !!parsed.retrieveOnly;
    const maxNeighbors = parsed.maxNeighbors ?? 5;
    const maxNoteTokens = parsed.maxNoteTokens ?? 2000;
    const noRefine = !!parsed.noRefine;
    const folder = parsed.folder;

    const task = buildRagTask(query, depth, topK, summarize, retrieveOnly, maxNeighbors, maxNoteTokens, noRefine, folder);
    applyVaultEnv(parsed);
    await runAgentSession(parsed, {
      tools: parsed.tools ?? [...RAG_TOOLS],
      task,
      labelName: "zk-ask",
    });
  },
};
