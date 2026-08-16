import type { MemoryRepository, MemoryTarget } from '../store/repository.js';
import type { MemoryCategory } from '../types.js';

export interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export interface MemorySearchArgs {
  query: string;
  project?: string | null;
  target?: string;
  category?: string;
  limit?: number;
}

export type MemorySearchExecute = ReturnType<typeof createMemorySearchExecute>;

/**
 * Build the memory-mode execute body (unified `search` tool, ticket 02).
 * Semantics are byte-identical to the retired `memory_search` tool:
 * getMemoryStats early-out + searchMemories + recallSet.record + touchMemory.
 */
export function createMemorySearchExecute(
  memoryRepo: MemoryRepository,
  recallSet?: { record(id: number): void },
) {
  return async (args: MemorySearchArgs) => {
    const query = args.query;
    const project = args.project;
    const target = args.target as MemoryTarget | undefined;
    const category = args.category as MemoryCategory | undefined;
    const limit = Math.min(args.limit || 10, 20);

    if (!query || query.trim().length === 0) {
      const result: SearchResult = { success: false, message: 'query is required' };
      return { content: [{ type: 'text' as const, text: result.message! }], details: result };
    }

    const stats = await memoryRepo.getMemoryStats();
    if (stats.total === 0) {
      const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use the memory tool with add action to store memories.' };
      return { content: [{ type: 'text' as const, text: result.message! }], details: result };
    }

    const results = await memoryRepo.searchMemories(query, { project, target, category, limit });

    // Bump last_referenced for matched entries — the live "last surfaced by search"
    // signal. Only explicit agent searches reach here (prompt injection reads the .md
    // store directly, not searchMemories), so this won't artificially keep entries
    // fresh. Best-effort: a touch failure must never break search.
    for (const entry of results) {
      // Record each recalled id into the shared recall-set (Task 2 producer).
      // Best-effort: a record failure must never break search (Set.add won't
      // throw in practice, but keep it consistent with the touch's try/catch).
      try { recallSet?.record(entry.id); } catch { /* best-effort */ }
      try { await memoryRepo.touchMemory(entry.id); } catch { /* best-effort */ }
    }

    if (results.length === 0) {
      const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
      return { content: [{ type: 'text' as const, text: result.message! }], details: result };
    }

    let output = `Found ${results.length} memories matching "${query}":\n\n`;

    for (const entry of results) {
      const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
      const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
      const categoryLabel = entry.category ? ` [${entry.category}]` : '';
      output += `${targetLabel} ${projectLabel}${categoryLabel} ${entry.content}\n`;
      output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
    }

    const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
    return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
  };
}
