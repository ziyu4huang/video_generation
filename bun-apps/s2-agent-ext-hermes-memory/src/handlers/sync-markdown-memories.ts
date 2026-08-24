/**
 * Markdown memory sync command — /memory-sync-markdown imports existing
 * Markdown-backed memories into the active search store (SQLite by default,
 * SurrealDB when configured). kp13 Wave B: the mirror target is the bundle
 * CardStore — each §-entry is mirrored as an md_id-keyed card row (target =
 * kind, md_id = frontmatter id, content = entry body, frontmatter = the
 * serializer envelope) in the SAME memories table. This startup pass IS the
 * lazy re-migration: entries without a stable id (comment-shape, pre-5d)
 * mirror on a later pass once the 5d backfill upgrades them, and the pass is
 * idempotent — re-running yields the same rows (md_id-keyed insert-once /
 * update-in-place / skip). The legacy content-keyed syncMemoryEntry mirror is
 * retired from this path; memoryRepo remains for the read-only lineage sweep.
 * The active backend's label is surfaced in the completion message via the
 * getLabel dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryRepository } from '../store/repository.js';
import type { CardStore } from '../store/card-store.js';
import type { Card } from '../store/card.js';
import { mirrorMemoryEntries, mirrorMemoryEntry } from '../store/memory-card-mirror.js';
import type { FailureState } from '../types.js';
import {
  parseMarkdownMemoryEntry,
  parseMetadataFrontmatter,
  serializeMetadataFrontmatter,
  detectEntryShape,
  defaultStateForCategory,
} from '../store/memory-format.js';
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from '../constants.js';
import { splitMemoryEntries } from '../merge-union.js';
import { AGENT_ROOT } from '../paths.js';
import { findDanglingLineageReferences, formatDanglingWarning } from './integrity-sweep.js';

export interface BackfillCounters {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  warnings: string[];
  /** Failure-lifecycle state backfill (Task 8): audit what the category-inferred
   *  backfill changed, so a mis-mapping can't silently hide a live failure. */
  failureState: {
    /** Stateless failure/correction/insight/preference entries backfilled to active. */
    active: number;
    /** Stateless tool-quirk/convention entries backfilled to acquired — these STOP injecting. */
    acquired: number;
    /** Failure entries that already had an explicit state (left untouched — idempotent). */
    unchanged: number;
    /** Previews of entries that became `acquired` (were injecting as missing→active, now won't). */
    stoppedInjecting: string[];
  };
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return splitMemoryEntries(raw);
}

type ParsedEntry = ReturnType<typeof parseMarkdownMemoryEntry>;

/** Mirror the parsed §-entries into the card store (md_id-keyed lazy
 *  re-migration). Per entry: absent → upsertCard (INSERT through the
 *  registered MemoryDedupStrategy); drifted content/envelope → updateCard
 *  (UPDATE in place, id stable); identical → skip. Entries with no stable id
 *  are counted as skipped — a later pass picks them up after the 5d backfill.
 *  Batched (2026-08-24 perf fix): one getCardsByKind per file instead of a
 *  per-entry getCard — the N+1 cost 103 HTTP round-trips per startup on the
 *  surreal backend. Per-entry failures record a precise warning and never
 *  lose the file; a batch-level failure falls back to the per-entry mirror. */
async function importEntries(
  cardStore: CardStore | null,
  counters: BackfillCounters,
  entries: string[],
  target: 'memory' | 'user' | 'failure',
  project: string | null = null,
  byId?: Map<string, Card>,
): Promise<void> {
  const inputs: Parameters<typeof mirrorMemoryEntries>[2] = [];
  for (const rawEntry of entries) {
    counters.entriesScanned++;
    try {
      const parsed = parseMarkdownMemoryEntry(rawEntry, target, project);
      inputs.push({
        mdId: parsed.mdId,
        content: parsed.content,
        created: parsed.created ?? null,
        last: parsed.lastReferenced ?? null,
        ...(parsed.state ? { state: parsed.state } : {}),
        ...(typeof parsed.severity === 'number' ? { severity: parsed.severity } : {}),
        ...(parsed.pin === true ? { pin: true } : {}),
      });
    } catch (err) {
      counters.warnings.push(
        `${path.basename(project ?? 'global')}/${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const count = (outcome: string): void => {
    if (outcome === 'inserted' || outcome === 'updated') counters.imported++;
    else counters.skipped++;
  };
  try {
    for (const outcome of await mirrorMemoryEntries(cardStore, target, inputs, byId)) count(outcome);
  } catch (err) {
    counters.warnings.push(
      `${path.basename(project ?? 'global')}/${target}: batch mirror failed (${err instanceof Error ? err.message : String(err)}) — retrying per entry`,
    );
    for (const input of inputs) {
      try {
        count(await mirrorMemoryEntry(cardStore, target, input));
      } catch (err2) {
        counters.warnings.push(
          `${path.basename(project ?? 'global')}/${target}: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
      }
    }
  }
}

/**
 * Idempotent failure-state backfill (Task 6 of hermes-failure-lifecycle). For
 * each FRONTMATTER failure entry whose decoded `state` is absent (a legacy
 * stateless entry written before the lifecycle feature), infer the initial
 * state from category (`defaultStateForCategory`) and persist it to BOTH the
 * `.md` frontmatter (source of truth) AND the matching DB row. Entries that
 * already carry a `state` are left untouched — this is what makes re-running a
 * no-op. Mirrors the stable-id backfill's parse → conditional-write → DB-mirror
 * discipline (that one mints `id` via `MemoryStore.backfillStableIds`; this
 * one mints `state` on the startup mirror).
 *
 * Invariants:
 * - **Idempotent**: only writes when `state` is absent; the file is not
 *   rewritten when no entry needs a state, so re-running changes nothing.
 * - **Never overwrites an explicit `state`** (even if it differs from the
 *   category default).
 * - **Body preserved verbatim**: re-`serializeMetadataFrontmatter` carries the
 *   original body text unchanged (the `[category]` prefix + ` — ` segments
 *   survive byte-identical).
 * - **Failure-target only** (runs over failures.md; memory/user entries have
 *   no state). Comment-shape entries have no frontmatter to carry state — they
 *   are upgraded by `backfillStableIds` first, then this backfill fills their
 *   state on a later run.
 * - **Best-effort**: per-entry DB-mirror failures are swallowed (recorded as a
 *   warning); the `.md` upgrade still lands and a later sync completes the mirror.
 */
async function backfillFailureState(
  cardStore: CardStore | null,
  filePath: string,
  counters: BackfillCounters,
): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  const entries = readEntries(filePath);
  if (entries.length === 0) return;

  let changed = false;
  const mirrors: Array<{ parsed: ParsedEntry; state: FailureState }> = [];
  const rebuilt: string[] = [];

  for (const raw of entries) {
    // Only frontmatter entries can carry `state`; comment-shape entries are
    // upgraded to frontmatter by the stable-id backfill first.
    if (detectEntryShape(raw) !== 'frontmatter') {
      rebuilt.push(raw);
      continue;
    }
    const parsed = parseMarkdownMemoryEntry(raw, 'failure', null);
    if (parsed.state !== undefined) {
      // Idempotent / never-overwrite: an explicit state is left untouched.
      counters.failureState.unchanged++;
      rebuilt.push(raw);
      continue;
    }
    const state = defaultStateForCategory(parsed.category ?? null);
    // Rewrite the frontmatter to include `state`, preserving the body verbatim.
    // parseMetadataFrontmatter surfaces every existing field (id/created/last/
    // severity/provenance/sources/memworth) so re-serialize is a faithful
    // round-trip with only `state` added.
    const fm = parseMetadataFrontmatter(raw);
    rebuilt.push(
      serializeMetadataFrontmatter({
        id: fm.id,
        text: fm.text,
        created: fm.created,
        last: fm.lastReferenced,
        state,
        severity: fm.severity ?? null,
        provenance: fm.provenance ?? null,
        sources: fm.sources ?? null,
        mwSuccess: fm.mwSuccess ?? null,
        mwFail: fm.mwFail ?? null,
      }),
    );
    mirrors.push({ parsed, state });
    // Dry-run audit (Task 8): count resulting states; flag entries that stop
    // injecting (stateless tool-quirk/convention → acquired: they injected as
    // missing→active before, and won't after this backfill).
    if (state === 'acquired') {
      counters.failureState.acquired++;
      counters.failureState.stoppedInjecting.push(parsed.content.slice(0, 60));
    } else {
      counters.failureState.active++;
    }
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, rebuilt.join(ENTRY_DELIMITER), 'utf-8');
  }

  // Mirror `state` onto the matching card row, md_id-keyed (kp13 Wave B). The
  // entry already mirrors via importEntries above; mirrorMemoryEntry compares
  // content AND envelope, so the drifted envelope (state now present) UPDATEs
  // the existing card in place — the id stays stable. When no card exists yet
  // the call INSERTs one with the right state (lazy re-migration parity).
  for (const { parsed, state } of mirrors) {
    try {
      await mirrorMemoryEntry(cardStore, 'failure', {
        mdId: parsed.mdId,
        content: parsed.content,
        created: parsed.created ?? null,
        last: parsed.lastReferenced ?? null,
        state,
        ...(typeof parsed.severity === 'number' ? { severity: parsed.severity } : {}),
      });
    } catch (err) {
      counters.warnings.push(
        `failures.md: state mirror failed for "${parsed.content.slice(0, 40)}" — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
  cardStore: CardStore | null = null,
): Promise<BackfillCounters & { projectCount: number }> {
  const counters: BackfillCounters = {
    filesScanned: 0,
    entriesScanned: 0,
    imported: 0,
    skipped: 0,
    warnings: [],
    failureState: { active: 0, acquired: 0, unchanged: 0, stoppedInjecting: [] },
  };

  const globalMemoryFile = path.join(globalDir, MEMORY_FILE);
  const globalUserFile = path.join(globalDir, USER_FILE);
  const globalFailureFile = path.join(globalDir, 'failures.md');

  // kp13 Wave B: the mirror target is the cardStore (md_id-keyed lazy
  // re-migration, idempotent — see importEntries). The memoryRepo content-keyed
  // batch mirror is retired; memoryRepo stays ONLY for the read-only lineage
  // sweep at the end of this pass.
  //
  // 2026-08-25 perf fix: ONE kind index per RUN (not per file). A 26-file
  // vault paid 26 getCardsByKind round-trips clean, 103–114 dirty. The map is
  // write-through (mirrorMemoryEntries keeps it current), so later files see
  // earlier files' writes exactly as the sequential per-file fetches did.
  // Caveat: backfillFailureState mirrors per-entry BELOW without writing
  // through to the failure map — harmless today (no failure-kind import runs
  // after it; the next run re-fetches), re-check if a failure file is ever
  // imported after the backfill.
  const kindIndex = new Map<'memory' | 'user' | 'failure', Map<string, Card>>();
  const indexFor = async (kind: 'memory' | 'user' | 'failure'): Promise<Map<string, Card>> => {
    let byId = kindIndex.get(kind);
    if (!byId) {
      const cards = cardStore ? await cardStore.getCardsByKind(kind) : [];
      byId = new Map(cards.map((c) => [c.id, c]));
      kindIndex.set(kind, byId);
    }
    return byId;
  };
  const importFile = async (
    filePath: string,
    target: 'memory' | 'user' | 'failure',
    project: string | null = null,
  ) => {
    if (!fs.existsSync(filePath)) return;
    counters.filesScanned++;
    const entries = readEntries(filePath);
    await importEntries(cardStore, counters, entries, target, project, await indexFor(target));
  };

  await importFile(globalMemoryFile, 'memory');
  await importFile(globalUserFile, 'user');
  await importFile(globalFailureFile, 'failure');

  // Task 6: idempotent failure-state backfill. Runs AFTER the failure import so
  // the DB rows exist; it rewrites stateless `.md` frontmatter entries to carry
  // the category-inferred `state` (source of truth) and mirrors it onto the row.
  // Re-running is a no-op (entries that already have a state are skipped).
  await backfillFailureState(cardStore, globalFailureFile, counters);

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

  // Integrity sweep (UPSP §4 / DO ticket 03): flag lineage pointers to rows
  // absent from the DB — the evicted-target rot overflow offload leaves behind
  // (a survivor's supersedes/parentIds still pointing at a removed target).
  // Best-effort: an advisory sweep failure must never break a sync that just
  // succeeded. Results land on the existing BackfillCounters.warnings channel.
  try {
    const dangling = findDanglingLineageReferences(await memoryRepo.getMemories());
    if (dangling.length > 0) {
      const CAP = 20;
      for (const d of dangling.slice(0, CAP)) {
        counters.warnings.push(formatDanglingWarning(d));
      }
      if (dangling.length > CAP) {
        counters.warnings.push(`… and ${dangling.length - CAP} more dangling lineage reference(s)`);
      }
    }
  } catch {
    // Non-fatal: advisory only. A DB/unreachable failure here must not block
    // the sync (the card mirror above never depended on it).
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
  cardStore: CardStore | null = null,
): void {
  pi.registerCommand('memory-sync-markdown', {
    description: 'Backfill Markdown memories into the active search store',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify('🔄 Scanning Markdown memory files for backfill into the active store…', 'info');

      try {
        const counters = await syncMarkdownMemories(memoryRepo, globalDir, projectsMemoryDir, agentRoot, inRepoProjectFile, inRepoProjectName, cardStore);
        const label = getLabel();

        let output = `\n✅ Markdown → memory store sync complete! (backend: ${label})\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Files scanned: ${counters.filesScanned}\n`;
        output += `├─ Entries scanned: ${counters.entriesScanned}\n`;
        output += `├─ Imported: ${counters.imported}\n`;
        output += `└─ Skipped as duplicates: ${counters.skipped}\n`;

        const fstate = counters.failureState;
        if (fstate.active + fstate.acquired + fstate.unchanged > 0) {
          output += `\n🏷️ Failure lifecycle state backfill:\n`;
          output += `├─ Backfilled to active (still injected): ${fstate.active}\n`;
          output += `├─ Backfilled to acquired (stop injecting): ${fstate.acquired}\n`;
          output += `└─ Already had explicit state (untouched): ${fstate.unchanged}\n`;
          if (fstate.stoppedInjecting.length > 0) {
            output += `\n⚠️ Stopped injecting (now acquired):\n`;
            for (const item of fstate.stoppedInjecting.slice(0, 10)) {
              output += `├─ ${item}\n`;
            }
            if (fstate.stoppedInjecting.length > 10) {
              output += `└─ ... and ${fstate.stoppedInjecting.length - 10} more\n`;
            }
          }
        }

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
