import * as path from 'node:path';
import type { SessionRepository } from '../store/repository.js';
import { searchSessionAnchors } from '../store/session-anchor-search.js';
import type { SessionAnchorRange, SessionAnchorSearchResult } from '../store/session-anchor-search.js';
import { AGENT_ROOT } from '../paths.js';

export interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  ranges?: SessionAnchorRange[];
}

export interface SessionSearchToolOptions {
  sessionsDir?: string;
}

export const DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions');

export interface LegacySessionSearchArgs {
  query: string;
  project?: string;
  role?: string;
  limit?: number;
}

/**
 * Build the legacy session-mode execute body (unified `search` tool, ticket 02).
 * Semantics are byte-identical to the retired legacy `session_search` variant:
 * getIndexedMessageCount early-out + searchSessions.
 */
export function createLegacySessionSearchExecute(sessionRepo: SessionRepository) {
  return async (args: LegacySessionSearchArgs) => {
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
  };
}

export interface AnchorSessionSearchArgs {
  markdown: string;
}

/**
 * Build the anchors session-mode execute body (unified `search` tool, ticket 02).
 * Semantics are byte-identical to the retired anchor `session_search` variant:
 * searchSessionAnchors over sessionsDir + compact anchor output.
 */
export function createAnchorSessionSearchExecute(sessionsDir: string) {
  return async (args: AnchorSessionSearchArgs) => {
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
  };
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
