/**
 * Markdown memory sync command — /memory-sync-markdown imports existing
 * Markdown-backed memories into the active search store (SQLite by default,
 * SurrealDB when configured). The write path is backend-neutral: it goes
 * through MemoryRepository.syncMemoryEntriesBatch (one batched round-trip /
 * transaction for the whole dirty set), so the same command works for every
 * backend. The active backend's label is surfaced in the completion message
 * via the getLabel dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryRepository, MemoryEntry } from '../store/repository.js';
import { parseMarkdownMemoryEntry } from '../store/memory-format.js';
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from '../constants.js';
import { AGENT_ROOT } from '../paths.js';

export interface BackfillCounters {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  warnings: string[];
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

type ParsedEntry = ReturnType<typeof parseMarkdownMemoryEntry>;

/** Dedup key mirroring syncMemoryEntry's SELECT scope (target/project/category)
 *  + exact content match. */
function existingKey(target: string, project: string | null, category: string | null, content: string): string {
  return `${target}|${project ?? ''}|${category ?? ''}|${content.trim()}`;
}

/** True iff syncMemoryEntry's merge (created=min, lastReferenced=max,
 *  optionals = existing ?? new) would reproduce `existing` unchanged — i.e. the
 *  round-trip is a no-op safe to skip. Conservative: any unparseable date or
 *  thrown comparison returns false (fall through to syncMemoryEntry). */
function mergeIsNoOp(existing: MemoryEntry, incoming: ParsedEntry): boolean {
  try {
    const exC = Date.parse(existing.created);
    const inC = Date.parse(incoming.created ?? existing.created);
    const exL = Date.parse(existing.lastReferenced);
    const inL = Date.parse(incoming.lastReferenced ?? existing.lastReferenced);
    if ([exC, inC, exL, inL].some((n) => !Number.isFinite(n))) return false;
    const n = (v: string | null | undefined) => (v ?? null);
    return exC <= inC
      && exL >= inL
      && (existing.category !== null || n(incoming.category) === null)
      && (existing.failureReason !== null || n(incoming.failureReason) === null)
      && (existing.toolState !== null || n(incoming.toolState) === null)
      && (existing.correctedTo !== null || n(incoming.correctedTo) === null);
  } catch {
    return false;
  }
}

/** Fetch every stored memory in ONE round-trip and index by dedup key. On
 *  failure returns an empty index — callers then fall through to
 *  syncMemoryEntry for every entry (correct, just not optimal). */
async function buildExistingIndex(memoryRepo: MemoryRepository): Promise<Map<string, MemoryEntry>> {
  try {
    const all = await memoryRepo.getMemories();
    const map = new Map<string, MemoryEntry>();
    for (const e of all) map.set(existingKey(e.target, e.project, e.category, e.content), e);
    return map;
  } catch {
    return new Map();
  }
}

async function importEntries(
  memoryRepo: MemoryRepository,
  counters: BackfillCounters,
  entries: string[],
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
  existingByContent: Map<string, MemoryEntry> = new Map(),
): Promise<void> {
  // Collect the dirty (non-no-op) entries and sync them in ONE batched call
  // (syncMemoryEntriesBatch) instead of one syncMemoryEntry per entry. The
  // Surreal backend collapses N per-entry HTTP round-trips into ≤2; SQLite
  // wraps the loop in one transaction. A batch failure falls back to per-entry
  // sync so a single bad entry still imports the rest and records a warning.
  const dirty: ParsedEntry[] = [];
  for (const rawEntry of entries) {
    counters.entriesScanned++;
    try {
      const parsed = parseMarkdownMemoryEntry(rawEntry, target, project);
      // Skip entries whose stored merge is already a no-op — avoids a
      // syncMemoryEntriesBatch round-trip that would change nothing.
      const existing = existingByContent.get(existingKey(parsed.target, parsed.project ?? null, parsed.category ?? null, parsed.content));
      if (existing && mergeIsNoOp(existing, parsed)) {
        counters.skipped++;
        continue;
      }
      dirty.push(parsed);
    } catch (err) {
      counters.warnings.push(
        `${path.basename(project ?? 'global')}/${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (dirty.length === 0) return;

  try {
    const results = await memoryRepo.syncMemoryEntriesBatch(dirty);
    for (const result of results) {
      if (result.action === 'inserted') counters.imported++;
      else counters.skipped++;
    }
  } catch (batchErr) {
    // Resilience: a batched transaction that fails (e.g. one malformed entry)
    // must not lose the whole file. Fall back to per-entry sync so the good
    // entries still import and the bad one records a precise warning.
    for (const parsed of dirty) {
      try {
        const result = await memoryRepo.syncMemoryEntry(parsed);
        if (result.action === 'inserted') counters.imported++;
        else counters.skipped++;
      } catch (err) {
        counters.warnings.push(
          `${path.basename(project ?? 'global')}/${target}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Surface the original batch failure once so it isn't silently swallowed.
    counters.warnings.push(
      `${path.basename(project ?? 'global')}/${target}: batch sync failed, fell back to per-entry — ${batchErr instanceof Error ? batchErr.message : String(batchErr)}`,
    );
  }
}

function scanProjectDirs(agentRoot: string, globalDir: string, projectsMemoryDir = "projects-memory"): Array<{ name: string; memoryFile: string }> {
  const projectsRoot = path.join(agentRoot, projectsMemoryDir);
  const projects = new Map<string, string>();

  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      const dir = path.join(projectsRoot, name);
      const memoryFile = path.join(dir, MEMORY_FILE);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(memoryFile)) {
        projects.set(name, memoryFile);
      }
    }
  }

  const resolvedAgentRoot = path.resolve(agentRoot);
  const resolvedGlobalDir = path.resolve(globalDir);
  const globalDirName = path.dirname(resolvedGlobalDir) === resolvedAgentRoot
    ? path.basename(resolvedGlobalDir)
    : null;
  if (fs.existsSync(agentRoot)) {
    for (const name of fs.readdirSync(agentRoot)) {
      if ((globalDirName && name === globalDirName) || name === projectsMemoryDir || name === 'skills' || name.startsWith('.')) continue;
      if (projects.has(name)) continue;
      const dir = path.join(agentRoot, name);
      const memoryFile = path.join(dir, MEMORY_FILE);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(memoryFile)) {
        projects.set(name, memoryFile);
      }
    }
  }

  return [...projects.entries()]
    .map(([name, memoryFile]) => ({ name, memoryFile }))
    .filter(({ memoryFile }) => fs.existsSync(memoryFile));
}

export async function syncMarkdownMemories(
  memoryRepo: MemoryRepository,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
  inRepoProjectFile?: string | null,
  inRepoProjectName?: string | null,
): Promise<BackfillCounters & { projectCount: number }> {
  const counters: BackfillCounters = {
    filesScanned: 0,
    entriesScanned: 0,
    imported: 0,
    skipped: 0,
    warnings: [],
  };

  const globalMemoryFile = path.join(globalDir, MEMORY_FILE);
  const globalUserFile = path.join(globalDir, USER_FILE);
  const globalFailureFile = path.join(globalDir, 'failures.md');

  // Fetch every stored memory ONCE (1 round-trip) and skip entries whose merge
  // is a no-op. Previously importEntries issued a syncMemoryEntry (SELECT +
  // merge/insert) PER entry — an N+1 costing ~655 round-trips / ~7s on the real
  // 219-entry store at every startup.
  const existingByContent = await buildExistingIndex(memoryRepo);

  const importFile = async (
    filePath: string,
    target: 'memory' | 'user' | 'failure',
    project: string | null = null,
  ) => {
    if (!fs.existsSync(filePath)) return;
    counters.filesScanned++;
    const entries = readEntries(filePath);
    await importEntries(memoryRepo, counters, entries, target, project, existingByContent);
  };

  await importFile(globalMemoryFile, 'memory');
  await importFile(globalUserFile, 'user');
  await importFile(globalFailureFile, 'failure');

  const projects = scanProjectDirs(agentRoot, globalDir, projectsMemoryDir);
  for (const project of projects) {
    await importFile(project.memoryFile, 'memory', project.name);
  }

  // In-repo project memory (ticket 04, decision 01/02): the project store's
  // MEMORY.md at <cwd>/.agents/memory/ (or an explicit projectMemoryDir),
  // tagged with the project name. Merges into the single DB alongside the
  // global + legacy project entries. Dedup absorbs any overlap with a legacy
  // scanProjectDirs hit.
  if (inRepoProjectFile) {
    await importFile(inRepoProjectFile, 'memory', inRepoProjectName ?? null);
  }

  return { ...counters, projectCount: projects.length };
}

export function registerSyncMarkdownMemoriesCommand(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository,
  globalDir: string,
  projectsMemoryDir: string | undefined,
  agentRoot = AGENT_ROOT,
  getLabel: () => string = () => "memory store",
  inRepoProjectFile?: string | null,
  inRepoProjectName?: string | null,
): void {
  pi.registerCommand('memory-sync-markdown', {
    description: 'Backfill Markdown memories into the active search store',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify('🔄 Scanning Markdown memory files for backfill into the active store…', 'info');

      try {
        const counters = await syncMarkdownMemories(memoryRepo, globalDir, projectsMemoryDir, agentRoot, inRepoProjectFile, inRepoProjectName);
        const label = getLabel();

        let output = `\n✅ Markdown → memory store sync complete! (backend: ${label})\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Files scanned: ${counters.filesScanned}\n`;
        output += `├─ Entries scanned: ${counters.entriesScanned}\n`;
        output += `├─ Imported: ${counters.imported}\n`;
        output += `└─ Skipped as duplicates: ${counters.skipped}\n`;

        if (counters.projectCount > 0) {
          output += `\n📁 Project memories scanned: ${counters.projectCount}\n`;
        }

        if (counters.warnings.length > 0) {
          output += `\n⚠️ Warnings (${counters.warnings.length}):\n`;
          for (const warning of counters.warnings.slice(0, 5)) {
            output += `├─ ${warning}\n`;
          }
          if (counters.warnings.length > 5) {
            output += `└─ ... and ${counters.warnings.length - 5} more\n`;
          }
        }

        output += `\n💡 Re-running this command is safe — existing rows are de-duplicated.`;
        ctx.ui.notify(output, 'info');
      } catch (err) {
        ctx.ui.notify(`❌ Markdown sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
