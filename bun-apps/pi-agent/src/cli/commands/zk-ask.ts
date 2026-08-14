/**
 * `zk-ask <question>` — Graph-enhanced RAG over the Zettelkasten vault.
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
import { applyVaultEnv } from "../sessions/passthrough.ts";
import { runAgentSession } from "../sessions/run-agent-session.ts";
import { buildRagTask, ragToolsFor, type BlendMode } from "@repo/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts";

const DETAILS = `Ask a natural language question; returns a synthesized answer grounded in vault notes.

Usage:
  pi-agent cli zk-ask <question>
  pi-agent cli zk-ask <question> --retrieve-only

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
  --blend <mode>         Retrieval blend: "default" (lexical+graph) | "three-way"
                         (semantic+lexical+graph) | "semantic-lexical" (semantic+
                         lexical, NO graph — isolates semantic from graph dilution).
                         Semantic modes need vault-mind service. Default: default.
                         Semantic modes tag each seed with source mode(s) under
                         --retrieve-only.
                         NOTE: "default" (lexical+graph) is the vault-wide default
                         PERMANENTLY (a DECISION, not a pending measurement) — the
                         semantic blends never won a regime across iter-3→iter-7
                         (iter-7 receipt 2026-07-07T01-00-52, English: lexical mean
                         rel 0.770 vs semantic-lexical 0.466, lexical wins 4/5; iter-6
                         zh-TW: 0.332 vs 0.100). RETIRED from the default READ path —
                         diagnostic/opt-in only; do NOT re-measure without a NEW
                         corpus or regime (10× vault / different embedding model). The
                         graph layer is the structure signal. Keep semantic blends as
                         explicit opt-in for known paraphrase / cross-lingual probes.
  --folder <name>        Restrict seed search to folder (default: Zettelkasten)
  --vault <path>         Absolute path to the vault
  --vault-dir <name>     Vault folder name under cwd (default: vault)
  --model <pattern>      provider/id[:thinking]
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --mode json            NDJSON event stream
  -p, --print            Non-interactive one-shot

Examples:
  pi-agent cli zk-ask "How does Bun handle workspaces?"
  pi-agent cli zk-ask "What is the relationship between Zettelkasten and atomic notes?" --depth 3
  pi-agent cli zk-ask "PDF processing pipeline" --summarize
  pi-agent cli zk-ask "LLM tool use patterns" --retrieve-only
  pi-agent cli zk-ask "atomic notes" --depth 1 --max-neighbors 3 --top-k 5`;

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
    const blendRaw = String(parsed.blend ?? "default");
    const blend: BlendMode =
      blendRaw === "three-way" ? "three-way"
      : blendRaw === "semantic-lexical" ? "semantic-lexical"
      : "default";

    const task = buildRagTask(query, depth, topK, summarize, retrieveOnly, maxNeighbors, maxNoteTokens, noRefine, folder, blend);
    applyVaultEnv(parsed);
    await runAgentSession(parsed, {
      tools: parsed.tools ?? ragToolsFor(blend),
      task,
      labelName: "zk-ask",
    });
  },
};
