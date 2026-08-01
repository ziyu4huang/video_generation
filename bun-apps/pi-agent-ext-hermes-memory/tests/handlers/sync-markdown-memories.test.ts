import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { MemorySyncInput } from '../../src/store/repository.js';
import { SqliteBackend } from '../../src/store/sqlite/sqlite-backend.js';
import { SqliteMemoryRepository } from '../../src/store/sqlite/sqlite-memory-repo.js';
import { registerMemoryTool } from '../../src/tools/memory-tool.js';
import {
  registerSyncMarkdownMemoriesCommand,
  syncMarkdownMemories,
} from '../../src/handlers/sync-markdown-memories.js';
import { ENTRY_DELIMITER } from '../../src/constants.js';
import { serializeMetadataFrontmatter, parseMetadataFrontmatter } from '../../src/store/memory-format.js';

/** Read the global failures.md (the failure-state backfill target). */
function readFailuresMd(globalDir: string): string {
  return fs.readFileSync(path.join(globalDir, 'failures.md'), 'utf-8');
}

/** Parse the frontmatter entry containing `marker` and return its `state`. */
function stateOfEntry(md: string, marker: string): string | undefined {
  const entries = md.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
  const entry = entries.find((e) => e.includes(marker));
  assert.ok(entry, `no entry containing "${marker}"`);
  return parseMetadataFrontmatter(entry).state;
}

describe('memory sqlite sync + markdown backfill', () => {
  let tmpDir: string;
  let agentRoot: string;
  let globalDir: string;
  let backend: SqliteBackend;
  let memoryRepo: SqliteMemoryRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sync-command-test-'));
    agentRoot = path.join(tmpDir, 'agent');
    globalDir = path.join(agentRoot, 'memory');
    fs.mkdirSync(globalDir, { recursive: true });
    backend = new SqliteBackend(globalDir);
    memoryRepo = new SqliteMemoryRepository(backend);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('memory tool writes are immediately searchable in SQLite', async () => {
    let capturedTool: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedTool = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: async () => ({
        success: true,
        target: 'memory',
        entries: ['sync token 2026-05-09'],
        usage: '1% — 20/5000 chars',
        entry_count: 1,
        message: 'Entry added.',
      }),
    } as any;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);

    await capturedTool.execute(
      'tc-1',
      { action: 'add', target: 'memory', content: 'sync token 2026-05-09' },
      undefined,
      undefined,
      undefined,
    );

    const results = await memoryRepo.searchMemories('sync token 2026-05-09', { target: 'memory' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'sync token 2026-05-09');
  });

  it('backfill command is idempotent across repeated runs', async () => {
    const memoryEntries = [
      'global memory one <!-- created=2026-05-08, last=2026-05-08 -->',
      'global memory two <!-- created=2026-05-08, last=2026-05-09 -->',
    ];
    const userEntries = [
      'name: Chandra <!-- created=2026-05-08, last=2026-05-08 -->',
    ];
    const failureEntries = [
      '[tool-quirk] npm cache stale — Failed: clear .cache/tsx <!-- created=2026-05-08, last=2026-05-09 -->',
    ];

    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), memoryEntries.join(ENTRY_DELIMITER), 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'USER.md'), userEntries.join(ENTRY_DELIMITER), 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'failures.md'), failureEntries.join(ENTRY_DELIMITER), 'utf-8');

    const projectDir = path.join(agentRoot, 'projects-memory', 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      'project memory entry <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    let handler: any;
    const mockPi = {
      registerCommand: (_name: string, opts: any) => {
        handler = opts.handler;
      },
    } as unknown as ExtensionAPI;

    const notifications: Array<{ message: string; severity: string }> = [];
    const ctx = {
      ui: {
        notify: (message: string, severity: string) => {
          notifications.push({ message, severity });
        },
      },
    } as any;

    registerSyncMarkdownMemoriesCommand(mockPi, memoryRepo, globalDir, undefined, agentRoot);

    await handler({}, ctx);
    const afterFirst = await memoryRepo.getMemories();

    await handler({}, ctx);
    const afterSecond = await memoryRepo.getMemories();

    assert.strictEqual(afterFirst.length, 5, 'first run should import all unique entries');
    assert.strictEqual(afterSecond.length, 5, 'second run should not create duplicates');

    const projectRows = await memoryRepo.getMemories({ project: 'project-a', target: 'memory' });
    assert.strictEqual(projectRows.length, 1);

    const failureRows = await memoryRepo.getMemories({ target: 'failure', category: 'tool-quirk' });
    assert.strictEqual(failureRows.length, 1);

    assert.ok(
      notifications.some((n) => n.message.includes('memory store sync complete')),
      'command should report completion',
    );
  });

  it('re-sync skips unchanged entries — zero syncMemoryEntriesBatch calls', async () => {
    const entries = [
      'skip-probe one <!-- created=2026-05-08, last=2026-05-08 -->',
      'skip-probe two <!-- created=2026-05-08, last=2026-05-09 -->',
      'skip-probe three <!-- created=2026-05-08, last=2026-05-09 -->',
    ];
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), entries.join(ENTRY_DELIMITER), 'utf-8');

    const first = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    assert.strictEqual(first.imported, 3, 'precondition: first sync imports all 3');

    // Spy: count syncMemoryEntriesBatch calls on the re-run. The per-entry N+1
    // now lives in this single batched call — skipping unchanged entries in-TS
    // must drive it to zero (empty dirty list → no batch call).
    const calls: MemorySyncInput[][] = [];
    const origBatch = memoryRepo.syncMemoryEntriesBatch.bind(memoryRepo);
    memoryRepo.syncMemoryEntriesBatch = async (inputs) => {
      calls.push(inputs);
      return origBatch(inputs);
    };

    const second = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    assert.strictEqual(calls.length, 0, 'unchanged entries must be skipped without a syncMemoryEntriesBatch call');
    assert.strictEqual(second.imported, 0);
    assert.strictEqual(second.skipped, 3);
  });

  it('re-sync calls syncMemoryEntriesBatch once with only the changed entries', async () => {
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      'delta-stable <!-- created=2026-05-08, last=2026-05-08 -->' +
        ENTRY_DELIMITER +
        'delta-changed <!-- created=2026-05-08, last=2026-05-08 -->',
      'utf-8',
    );
    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);

    // Bump lastReferenced on ONE entry → its merge is no longer a no-op.
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      'delta-stable <!-- created=2026-05-08, last=2026-05-08 -->' +
        ENTRY_DELIMITER +
        'delta-changed <!-- created=2026-05-08, last=2026-05-10 -->',
      'utf-8',
    );

    const calls: MemorySyncInput[][] = [];
    const origBatch = memoryRepo.syncMemoryEntriesBatch.bind(memoryRepo);
    memoryRepo.syncMemoryEntriesBatch = async (inputs) => {
      calls.push(inputs);
      return origBatch(inputs);
    };

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    assert.strictEqual(calls.length, 1, 'all dirty entries must sync in a single batched call');
    assert.strictEqual(calls[0].length, 1, 'only the changed entry is in the batch');
    assert.strictEqual(calls[0][0].content, 'delta-changed');
  });

  it('backfills legacy project memory directories from the old ~/.pi/agent/<project> layout', async () => {
    const legacyProjectDir = path.join(agentRoot, 'legacy-project');
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyProjectDir, 'MEMORY.md'),
      'legacy project entry <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    let handler: any;
    const mockPi = {
      registerCommand: (_name: string, opts: any) => {
        handler = opts.handler;
      },
    } as unknown as ExtensionAPI;

    const ctx = {
      ui: {
        notify: () => {},
      },
    } as any;

    registerSyncMarkdownMemoriesCommand(mockPi, memoryRepo, globalDir, undefined, agentRoot);
    await handler({}, ctx);

    const projectRows = await memoryRepo.getMemories({ project: 'legacy-project', target: 'memory' });
    assert.strictEqual(projectRows.length, 1);
    assert.strictEqual(projectRows[0].content, 'legacy project entry');
  });

  it('makes new-layout project markdown searchable when startup sync runs', async () => {
    const projectDir = path.join(agentRoot, 'projects-memory', 'latest-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      'latest path searchable entry <!-- created=2026-05-11, last=2026-05-11 -->',
      'utf-8',
    );

    const counters = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);

    assert.strictEqual(counters.projectCount, 1);
    assert.strictEqual(counters.imported, 1);

    const results = await memoryRepo.searchMemories('latest path searchable entry', {
      project: 'latest-project',
      target: 'memory',
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'latest path searchable entry');
  });

  it('still scans project markdown under ~/.pi/agent when memoryDir is customized elsewhere', async () => {
    const customGlobalDir = path.join(tmpDir, 'external-memory-root');
    fs.mkdirSync(customGlobalDir, { recursive: true });

    const customBackend = new SqliteBackend(customGlobalDir);
    const customMemoryRepo = new SqliteMemoryRepository(customBackend);
    try {
      const projectDir = path.join(agentRoot, 'projects-memory', 'custom-root-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'MEMORY.md'),
        'custom root project entry <!-- created=2026-05-11, last=2026-05-11 -->',
        'utf-8',
      );

      const counters = await syncMarkdownMemories(customMemoryRepo, customGlobalDir, undefined, agentRoot);

      assert.strictEqual(counters.projectCount, 1);
      const results = await customMemoryRepo.searchMemories('custom root project entry', {
        project: 'custom-root-project',
        target: 'memory',
      });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].content, 'custom root project entry');
    } finally {
      await customBackend.close();
    }
  });

  it('command output is backend-neutral and surfaces the active backend label', async () => {
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      'neutrality probe <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    let handler: any;
    const mockPi = {
      registerCommand: (_name: string, opts: any) => {
        handler = opts.handler;
      },
    } as unknown as ExtensionAPI;

    const notifications: Array<{ message: string; severity: string }> = [];
    const ctx = {
      ui: {
        notify: (message: string, severity: string) => {
          notifications.push({ message, severity });
        },
      },
    } as any;

    registerSyncMarkdownMemoriesCommand(
      mockPi, memoryRepo, globalDir, undefined, agentRoot,
      () => 'TestBackend · ns=x',
    );
    await handler({}, ctx);

    const all = notifications.map((n) => n.message).join('\n');
    assert.ok(all.includes('TestBackend · ns=x'), 'must surface the active backend label');
    assert.ok(!all.toLowerCase().includes('sqlite'), 'must not hardcode "sqlite" (any case)');
    assert.ok(!all.toLowerCase().includes('surrealdb'), 'must not hardcode "surrealdb" (any case)');
    assert.ok(all.includes('memory store sync complete'), 'must use the backend-neutral noun');
  });

  it('backfills the in-repo project memory file (.agents/memory/) tagged with the project name (ticket 04)', async () => {
    // The project store's MEMORY.md at <cwd>/.agents/memory/ (or an explicit
    // projectMemoryDir) — the second source from decision 02. Passed via the
    // inRepoProjectFile param; merged into the single DB tagged with the project.
    const inRepoDir = path.join(tmpDir, 'repo', '.agents', 'memory');
    fs.mkdirSync(inRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(inRepoDir, 'MEMORY.md'),
      'in-repo project convention <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    await syncMarkdownMemories(
      memoryRepo, globalDir, undefined, agentRoot,
      path.join(inRepoDir, 'MEMORY.md'),
      'demo-repo',
    );

    // Searchable under the project name (single DB, tag-on-index — decision 02).
    const projectRows = await memoryRepo.getMemories({ project: 'demo-repo', target: 'memory' });
    assert.strictEqual(projectRows.length, 1);
    assert.strictEqual(projectRows[0].content, 'in-repo project convention');
  });

  it('search merges legacy global + in-repo project entries for the same project (ticket 05 merge pin)', async () => {
    // Decision 02 (single DB, tag-on-index) + decision 03 (leave): a project's
    // memory can be split across the legacy global store
    // (~/.pi/agent/projects-memory/<project>/) and the in-repo store
    // (.agents/memory/). Both must surface in one search — the end-to-end
    // property of the project-memory split. Regression pin: guards against a
    // future change that drops either source from the index.
    const projectName = 'split-project';

    // Legacy global project entry (scanned via scanProjectDirs).
    const legacyDir = path.join(agentRoot, 'projects-memory', projectName);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'MEMORY.md'),
      'legacy global project entry <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    // In-repo project entry (scanned via the inRepoProjectFile param).
    const inRepoDir = path.join(tmpDir, 'repo', '.agents', 'memory');
    fs.mkdirSync(inRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(inRepoDir, 'MEMORY.md'),
      'in-repo project entry <!-- created=2026-05-08, last=2026-05-09 -->',
      'utf-8',
    );

    await syncMarkdownMemories(
      memoryRepo, globalDir, undefined, agentRoot,
      path.join(inRepoDir, 'MEMORY.md'),
      projectName,
    );

    // Both sources merged under the same project tag — the split works end-to-end.
    const rows = await memoryRepo.getMemories({ project: projectName, target: 'memory' });
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(
      rows.map((r) => r.content).sort(),
      ['in-repo project entry', 'legacy global project entry'],
    );
  });

  it('startup mirror stamps md_id from an externally-edited frontmatter entry (Task 7 re-review must-fix 2)', async () => {
    // An entry that was hand-edited (or born before this fix) into the YAML
    // frontmatter shape carries a stable `id` in the .md. The startup mirror
    // (`syncMarkdownMemories` → `syncMemoryEntry`/`syncMemoryEntriesBatch`) must
    // surface that id as `MemorySyncInput.mdId` so the SQLite `md_id` (Surreal
    // `mdId`) is stamped on the INSERT — NOT left NULL. Pre-fix the mirror read
    // `.mdId` (never set; the parser surfaced it only as `.id`), so the row
    // landed md_id = NULL, a permanent orphan once evicted before any restart
    // re-sync (backfillStableIds skips frontmatter entries).
    const externalId = 'ext-frontmatter-id-1234';
    const entry = serializeMetadataFrontmatter({
      id: externalId,
      text: 'externally edited frontmatter entry',
      created: '2026-05-08',
      last: '2026-05-09',
    });
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), entry, 'utf-8');

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);

    const rows = await memoryRepo.getMemories({ target: 'memory' });
    assert.strictEqual(rows.length, 1, 'mirror should insert exactly one row');
    assert.strictEqual(rows[0].content, 'externally edited frontmatter entry');
    assert.ok(rows[0].mdId !== null && rows[0].mdId !== undefined, 'md_id must NOT be null/undefined');
    assert.strictEqual(rows[0].mdId, externalId, 'mirror must stamp md_id from the frontmatter id');

    // Same id recoverable via the content→md_id lookup the purge/eviction paths use.
    assert.strictEqual(
      await memoryRepo.getMdIdByContent('externally edited frontmatter entry', { target: 'memory' }),
      externalId,
    );
  });

  it('backfill sets failure state by category for stateless entries + mirrors to DB (Task 6)', async () => {
    // Legacy stateless entries: frontmatter (post stable-id migration) but NO
    // `state` field. The backfill infers the initial state from category and
    // persists it to BOTH the .md frontmatter (source of truth) and the DB row.
    const failureEntry = serializeMetadataFrontmatter({
      id: 'fail-backfill-1',
      text: '[failure] boom — Failed: x',
      created: '2026-05-08',
      last: '2026-05-09',
    });
    const quirkEntry = serializeMetadataFrontmatter({
      id: 'quirk-backfill-1',
      text: '[tool-quirk] known quirk',
      created: '2026-05-08',
      last: '2026-05-09',
    });
    fs.writeFileSync(
      path.join(globalDir, 'failures.md'),
      [failureEntry, quirkEntry].join(ENTRY_DELIMITER),
      'utf-8',
    );

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);

    const md = readFailuresMd(globalDir);
    assert.strictEqual(stateOfEntry(md, '[failure] boom'), 'active');
    assert.strictEqual(stateOfEntry(md, '[tool-quirk] known quirk'), 'acquired');

    // DB mirror: the inferred state lands on the matching row by content key
    // (failure→active, tool-quirk→acquired — NOT the INSERT default active).
    const rows = await memoryRepo.getMemories({ target: 'failure' });
    const failureRow = rows.find((r) => r.content === '[failure] boom — Failed: x');
    const quirkRow = rows.find((r) => r.content === '[tool-quirk] known quirk');
    assert.ok(failureRow, 'failure row must exist');
    assert.ok(quirkRow, 'tool-quirk row must exist');
    assert.strictEqual(failureRow!.state, 'active');
    assert.strictEqual(quirkRow!.state, 'acquired');
  });

  it('failure-state backfill is idempotent — re-running does not rewrite the .md (Task 6)', async () => {
    const failureEntry = serializeMetadataFrontmatter({
      id: 'fail-backfill-2',
      text: '[failure] boom — Failed: x',
      created: '2026-05-08',
      last: '2026-05-09',
    });
    const quirkEntry = serializeMetadataFrontmatter({
      id: 'quirk-backfill-2',
      text: '[tool-quirk] known quirk',
      created: '2026-05-08',
      last: '2026-05-09',
    });
    fs.writeFileSync(
      path.join(globalDir, 'failures.md'),
      [failureEntry, quirkEntry].join(ENTRY_DELIMITER),
      'utf-8',
    );

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    const after1 = readFailuresMd(globalDir);

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    const after2 = readFailuresMd(globalDir);

    assert.strictEqual(after2, after1, 'second run must not rewrite the .md');
  });

  it('backfill never overwrites an explicit failure state (Task 6)', async () => {
    // An entry already carrying `state: resolved` must stay resolved — NOT reset
    // to the category default (active).
    const resolvedEntry = serializeMetadataFrontmatter({
      id: 'fail-resolved-1',
      text: '[failure] already fixed — Failed: y',
      created: '2026-05-08',
      last: '2026-05-09',
      state: 'resolved',
    });
    fs.writeFileSync(path.join(globalDir, 'failures.md'), resolvedEntry, 'utf-8');

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);

    const md = readFailuresMd(globalDir);
    assert.strictEqual(stateOfEntry(md, '[failure] already fixed'), 'resolved');

    const rows = await memoryRepo.getMemories({ target: 'failure' });
    const row = rows.find((r) => r.content === '[failure] already fixed — Failed: y');
    assert.ok(row, 'failure row must exist');
    assert.strictEqual(row!.state, 'resolved', 'explicit resolved state must survive');
  });

  it('backfill preserves the failure body segments verbatim (Task 6)', async () => {
    const body = '[failure] boom — Failed: x — Tool state: z';
    const entry = serializeMetadataFrontmatter({
      id: 'fail-body-1',
      text: body,
      created: '2026-05-08',
      last: '2026-05-09',
    });
    fs.writeFileSync(path.join(globalDir, 'failures.md'), entry, 'utf-8');

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);

    const md = readFailuresMd(globalDir);
    const entries = md.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
    const fm = parseMetadataFrontmatter(entries[0]);
    assert.strictEqual(fm.state, 'active', 'state was backfilled');
    assert.strictEqual(fm.text, body, 'failure body must survive byte-identical');
  });
});
