import * as path from 'node:path';
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import type { SessionRepository } from '../store/repository.js';
import { searchSessionAnchors } from '../store/session-anchor-search.js';
import type { SessionAnchorRange, SessionAnchorSearchResult } from '../store/session-anchor-search.js';
import type { SessionSearchConfig } from '../types.js';
import { AGENT_ROOT } from '../paths.js';

// ─── Gate family (wayfinder ticket 02 — demoted from core) ──────────────────
GATE_DEFS["session_search"] = {
  id: "session_search",
  keywords: ["session search", "past session", "previous discussion", "earlier session", "search sessions", "搜尋 session", "之前的對話", "上次討論"],
  requires: {
    nouns: ["session", "discussion", "conversation", "討論", "對話"],
    verbs: ["search", "find", "recall", "look up", "搜尋", "找", "回顧"],
  },
  description: "Search past Pi sessions for relevant context",
};

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  ranges?: SessionAnchorRange[];
}

interface SessionSearchToolOptions {
  sessionsDir?: string;
}

const DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions');

export function registerSessionSearchTool(
  pi: ExtensionAPI,
  sessionRepo: SessionRepository,
  sessionSearchConfig: SessionSearchConfig = { variant: 'legacy' },
  options: SessionSearchToolOptions = {},
): void {
  if (sessionSearchConfig.variant === 'anchors') {
    registerAnchorSessionSearchTool(pi, options.sessionsDir ?? DEFAULT_SESSIONS_DIR);
    return;
  }

  registerLegacySessionSearchTool(pi, sessionRepo);
}

function registerAnchorSessionSearchTool(pi: ExtensionAPI, sessionsDir: string): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    gating: { gate: 'session_search' }, // demoted from core (ticket 02)
    description: `Search Pi session JSONL files in the opt-in anchor mode using a Markdown request.

This mode accepts only a markdown request. Supported scalar fields are from, to, cwd, and limit. Supported list sections are all, any, and exclude: all terms must match, any requires at least one listed term, and exclude removes matching ranges. It returns compact JSONL line-range anchors, not summaries or previews. Output is plain text: count, optional message, then anchors as path:startLine-endLine with a short reason.

Example:
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
      markdown: Type.String({ description: 'Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists.' }),
    }),
    execute: async (_id: string, args: { markdown: string }) => {
      const markdown = args.markdown;

      if (!markdown || markdown.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'markdown is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const searchResult = searchSessionAnchors(markdown, { sessionsDir });
      if (!searchResult.success) {
        const result: SearchResult = { success: false, message: searchResult.message ?? 'Anchor session search failed.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const output = formatAnchorSearchOutput(searchResult);
      const result: SearchResult = {
        success: true,
        count: searchResult.ranges.length,
        message: searchResult.message,
        output,
        ranges: searchResult.ranges,
      };
      return { content: [{ type: 'text' as const, text: output }], details: result };
    },
  });
}

function formatAnchorSearchOutput(searchResult: SessionAnchorSearchResult): string {
  const lines = [`count: ${searchResult.ranges.length}`];
  if (searchResult.message) lines.push(`message: ${searchResult.message}`);
  if (searchResult.ranges.length > 0) {
    lines.push("anchors:");
    for (const range of searchResult.ranges) {
      const anchor = `${range.path}:${range.startLine}-${range.endLine}`;
      const reason = compactReason(range.reason);
      lines.push(reason ? `- ${anchor} — ${reason}` : `- ${anchor}`);
    }
  }
  return lines.join("\n");
}

function compactReason(reason: string | undefined): string {
  if (!reason) return "";
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
}

function registerLegacySessionSearchTool(pi: ExtensionAPI, sessionRepo: SessionRepository): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    gating: { gate: 'session_search' }, // demoted from core (ticket 02)
    description: `Search across past Pi coding sessions for relevant conversation context. Use this when the user asks about previous discussions, past work, or when you need context from earlier sessions.

Examples:
- "What did we discuss about auth last week?"
- "Find the PR where we fixed the test hang"
- "What approach did we take for the database migration?"

Returns conversation snippets with session dates and project context.`,
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name (optional).' })),
      role: Type.Optional(StringEnum(['user', 'assistant'] as const, { description: 'Filter by message role (optional).' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; role?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const role = args.role;
      const limit = Math.min(args.limit || 10, 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const totalMessages = await sessionRepo.getIndexedMessageCount();
      if (totalMessages === 0) {
        const result: SearchResult = { success: false, message: 'No sessions indexed yet. Run /memory-index-sessions to import past sessions.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = await sessionRepo.searchSessions(query, {
        project,
        role: role as "user" | "assistant" | "system" | undefined,
        limit,
      });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No results found for "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} results for "${query}":\n\n`;

      for (const r of results) {
        const date = new Date(r.timestamp).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

        output += `---\n`;
        output += `📅 ${date} | 📁 ${r.project} | ${r.role === 'user' ? '👤 User' : '🤖 Assistant'}\n`;
        output += `${r.content}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
 * (recallFloor 0, adversarial []): demoted from core in ticket 02; narrow
 * keywords are intentional, so we assert the predicate fires on its own
 * keyword/requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  gate: "session_search",
  recallFloor: 0,
  adversarial: [],
  controls: ['search past sessions for the auth discussion', 'search past sessions for the auth discussion', 'recall the discussion about auth from last week', 'what did we discuss in the earlier session about lora'],
};
