/**
 * Unified `search` tool (ticket 02) — merges the retired `memory_search` and
 * `session_search` registrations behind ONE core-gated tool with a `mode`
 * selector. The execute bodies are untouched: dispatch routes to the helper
 * factories extracted by the prior slice (memory-search-tool.ts /
 * session-search-tool.ts), so per-mode behavior, validation messages, and
 * formatting stay byte-identical to the retired tools.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { MemoryRepository, SessionRepository } from "../store/repository.js";
import type { SessionSearchConfig } from "../types.js";
import { createMemorySearchExecute } from "./memory-search-tool.js";
import {
  createLegacySessionSearchExecute,
  createAnchorSessionSearchExecute,
  DEFAULT_SESSIONS_DIR,
} from "./session-search-tool.js";

export interface SearchToolOptions {
  sessionsDir?: string;
}

export interface SearchArgs {
  mode?: "memory" | "session";
  query?: string;
  project?: string | null;
  target?: string;
  category?: string;
  role?: string;
  limit?: number;
  markdown?: string;
}

export function registerSearchTool(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository,
  sessionRepo: SessionRepository,
  sessionSearchConfig: SessionSearchConfig = { variant: "legacy" },
  recallSet?: { record(id: number): void },
  options: SearchToolOptions = {},
): void {
  const sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  const memoryExecute = createMemorySearchExecute(memoryRepo, recallSet);
  const anchorSessionExecute = createAnchorSessionSearchExecute(sessionsDir);
  const legacySessionExecute = createLegacySessionSearchExecute(sessionRepo);

  pi.registerTool({
    // Renamed 2026-08-20 (tool-name verb_object effort): legacy name `search`
    // — see docs/agents/extension-naming.md for the rename history.
    name: "search_memory",
    label: "Search",
    gating: { core: true },
    description: `Search memories and past Pi sessions. mode=memory searches the extended memory store; mode=session searches past sessions.

memory mode:
- Topic lookup: "What do I know about auth setup?"
- Past failures: query "auth", category "failure"

session mode (legacy variant) — searches past Pi coding sessions; returns conversation snippets with session dates and project context. Examples: "What did we discuss about auth last week?", "Find the PR where we fixed the test hang".

session mode (anchors variant) — accepts only a markdown request: scalar fields from, to, cwd, limit; list sections all (all terms must match), any (at least one must match), exclude (drops matches). Returns compact JSONL line-range anchors, not summaries. Example:
from: 2026-05-14
to: 2026-05-15
cwd: /path/to/project
limit: 20

all:
- alpha

any:
- beta
- gamma

exclude:
- delta`,
    parameters: Type.Object({
      mode: StringEnum(["memory", "session"] as const, {
        description: "memory = extended memory store; session = past Pi sessions.",
        default: "memory",
      }),
      query: Type.Optional(
        Type.String({ description: "Search query (natural language or terms). Required for memory and legacy session modes." }),
      ),
      project: Type.Optional(
        Type.Union([Type.String(), Type.Null()], {
          description: "Filter by project; null = global memories only (memory mode; ignored in session mode).",
        }),
      ),
      target: Type.Optional(
        StringEnum(["memory", "user", "failure"] as const, {
          description: "Filter by target type (memory mode only).",
        }),
      ),
      category: Type.Optional(
        StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
          description: "Filter by memory category (memory mode only).",
        }),
      ),
      role: Type.Optional(
        StringEnum(["user", "assistant"] as const, { description: "Filter by message role (legacy session mode only)." }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 20)." })),
      markdown: Type.Optional(
        Type.String({
          description:
            "Markdown request (from/to/cwd/limit fields, all/any/exclude lists). Required for session mode with anchors variant.",
        }),
      ),
    }),
    async execute(_toolCallId: string, args: SearchArgs) {
      const mode = args.mode ?? "memory";

      if (mode === "session") {
        // Mirrors the retired registerSessionSearchTool dispatch: variant picks
        // the anchors implementation, everything else is the legacy one.
        if (sessionSearchConfig.variant === "anchors") {
          return anchorSessionExecute({ markdown: args.markdown ?? "" });
        }
        return legacySessionExecute({
          query: args.query ?? "",
          project: args.project ?? undefined,
          role: args.role,
          limit: args.limit,
        });
      }

      return memoryExecute({
        query: args.query ?? "",
        project: args.project,
        target: args.target,
        category: args.category,
        limit: args.limit,
      });
    },
  });
}
