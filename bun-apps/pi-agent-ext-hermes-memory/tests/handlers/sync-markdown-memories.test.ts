import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { MemoryRepository, MemoryEntry } from '../../src/store/repository.js';
import { SqliteBackend } from '../../src/store/sqlite/sqlite-backend.js';
import { SqliteMemoryRepository } from '../../src/store/sqlite/sqlite-memory-repo.js';
import { createCardStore } from '../../src/store/card-store.js';
import type { CardStore } from '../../src/store/card-store.js';
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
  let cardStore: CardStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sync-command-test-'));
    agentRoot = path.join(tmpDir, 'agent');
    globalDir = path.join(agentRoot, 'memory');
    fs.mkdirSync(globalDir, { recursive: true });
    backend = new SqliteBackend(globalDir);
    memoryRepo = new SqliteMemoryRepository(backend);
  });

  afterEach(async () => {
    if (cardStore) await cardStore.close();
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Real card store joined on the shared backend — kp13 Wave B: the startup
   *  pass mirrors §-entries HERE (md_id-keyed lazy re-migration), so tests that
   *  exercise the mirror must opt in before their first sync. */
  async function makeCardStore(): Promise<CardStore> {
    cardStore = await createCardStore({ memoryDir: globalDir, sqliteBackend: backend });
    return cardStore;
  }

  /** Frontmatter §-entry fixture with a stable id (the 5d shape the lazy
   *  re-migration keys on). */
  function fm(id: string, text: string, created = '2026-05-08', last = '2026-05-09'): string {
    return serializeMetadataFrontmatter({ id, text, created, last });
  }

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
        added_md_id: 'md-live-sync-1',
      }),
    } as any;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());

    await capturedTool.execute(
      'tc-1',
      { action: 'add', target: 'memory', content: 'sync token 2026-05-09' },
      undefined,
      undefined,
      undefined,
    );

    // kp13 Wave B: the mirror lands as a card row (same table → still searchable).
    const cards = await cardStore.getCardsByKind('memory');
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].id, 'md-live-sync-1');
    const results = await memoryRepo.searchMemories('sync token 2026-05-09', { target: 'memory' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'sync token 2026-05-09');
  });

  it('backfill command is idempotent across repeated runs', async () => {
    const memoryEntries = [
      fm('md-idem-m1', 'global memory one', '2026-05-08', '2026-05-08'),
      fm('md-idem-m2', 'global memory two'),
    ];
    const userEntries = [
      fm('md-idem-u1', 'name: Chandra', '2026-05-08', '2026-05-08'),
    ];
    const failureEntries = [
      fm('md-idem-f1', '[tool-quirk] npm cache stale — Failed: clear .cache/tsx'),
    ];

    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), memoryEntries.join(ENTRY_DELIMITER), 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'USER.md'), userEntries.join(ENTRY_DELIMITER), 'utf-8');
    fs.writeFileSync(path.join(globalDir, 'failures.md'), failureEntries.join(ENTRY_DELIMITER), 'utf-8');

    const projectDir = path.join(agentRoot, 'projects-memory', 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      fm('md-idem-p1', 'project memory entry'),
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

    registerSyncMarkdownMemoriesCommand(mockPi, memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, undefined, await makeCardStore());

    await handler({}, ctx);
    const firstMem = await cardStore.getCardsByKind('memory');
    const firstUser = await cardStore.getCardsByKind('user');
    const firstFail = await cardStore.getCardsByKind('failure');

    await handler({}, ctx);
    const secondMem = await cardStore.getCardsByKind('memory');
    const secondUser = await cardStore.getCardsByKind('user');
    const secondFail = await cardStore.getCardsByKind('failure');

    // Lazy re-migration: 5 md_id-keyed cards (3 memory incl. the project entry
    // + 1 user + 1 failure); the second run is a full no-op (stable rows).
    assert.strictEqual(firstMem.length + firstUser.length + firstFail.length, 5, 'first run should mirror all unique entries');
    assert.deepStrictEqual(
      [...secondMem, ...secondUser, ...secondFail].map((c) => c.id).sort(),
      [...firstMem, ...firstUser, ...firstFail].map((c) => c.id).sort(),
      'second run should not create duplicates',
    );

    const projectCard = firstMem.find((c) => c.content === 'project memory entry');
    assert.ok(projectCard, 'project entry mirrors as a kind:memory card');

    const failureCard = firstFail.find((c) => c.content.includes('npm cache stale'));
    assert.ok(failureCard, 'tool-quirk failure mirrors as a kind:failure card');

    assert.ok(
      notifications.some((n) => n.message.includes('memory store sync complete')),
      'command should report completion',
    );
  });

  it('re-sync skips unchanged entries (md_id-keyed idempotence, no writes)', async () => {
    const entries = [
      fm('md-skip-1', 'skip-probe one', '2026-05-08', '2026-05-08'),
      fm('md-skip-2', 'skip-probe two'),
      fm('md-skip-3', 'skip-probe three'),
    ];
    fs.writeFileSync(path.join(globalDir, 'MEMORY.md'), entries.join(ENTRY_DELIMITER), 'utf-8');

    await makeCardStore();
    const first = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);
    assert.strictEqual(first.imported, 3, 'precondition: first sync mirrors all 3');

    const second = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);
    assert.strictEqual(second.imported, 0, 'unchanged entries are skipped (no insert, no update)');
    assert.strictEqual(second.skipped, 3);
    const cards = await cardStore.getCardsByKind('memory');
    assert.strictEqual(cards.length, 3, 'row count stable — no duplicates');
  });

  it('re-sync updates only the drifted entry, in place (md_id stable)', async () => {
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      fm('md-delta-stable', 'delta-stable', '2026-05-08', '2026-05-08') +
        ENTRY_DELIMITER +
        fm('md-delta-changed', 'delta-changed', '2026-05-08', '2026-05-08'),
      'utf-8',
    );
    await makeCardStore();
    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);

    // Bump lastReferenced on ONE entry → its envelope drifted → updateCard.
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      fm('md-delta-stable', 'delta-stable', '2026-05-08', '2026-05-08') +
        ENTRY_DELIMITER +
        fm('md-delta-changed', 'delta-changed', '2026-05-08', '2026-05-10'),
      'utf-8',
    );

    const second = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);
    assert.strictEqual(second.imported, 1, 'only the drifted entry updates');
    assert.strictEqual(second.skipped, 1);

    const cards = await cardStore.getCardsByKind('memory');
    assert.strictEqual(cards.length, 2, 'no new rows — update-in-place keeps the id stable');
    const changed = cards.find((c) => c.id === 'md-delta-changed')!;
    assert.strictEqual(changed.frontmatter.last, '2026-05-10', 'drifted envelope refreshed');
  });

  it('backfills legacy project memory directories from the old ~/.pi/agent/<project> layout', async () => {
    const legacyProjectDir = path.join(agentRoot, 'legacy-project');
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyProjectDir, 'MEMORY.md'),
      fm('md-legacy-1', 'legacy project entry'),
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

    registerSyncMarkdownMemoriesCommand(mockPi, memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, undefined, await makeCardStore());
    await handler({}, ctx);

    const cards = await cardStore.getCardsByKind('memory');
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].content, 'legacy project entry');
    assert.strictEqual(cards[0].id, 'md-legacy-1');
  });

  it('makes new-layout project markdown searchable when startup sync runs', async () => {
    const projectDir = path.join(agentRoot, 'projects-memory', 'latest-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'MEMORY.md'),
      fm('md-latest-1', 'latest path searchable entry', '2026-05-11', '2026-05-11'),
      'utf-8',
    );

    const counters = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, await makeCardStore());

    assert.strictEqual(counters.projectCount, 1);
    assert.strictEqual(counters.imported, 1);

    // The card row lands in the same memories table (project-agnostic) and
    // stays FTS-searchable without the project filter.
    const results = await memoryRepo.searchMemories('latest path searchable entry', {
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
    // kp13 Wave B: the mirror target is a cardStore joined on the SAME custom
    // backend (not the suite's default one).
    const customCardStore = await createCardStore({ memoryDir: customGlobalDir, sqliteBackend: customBackend });
    try {
      const projectDir = path.join(agentRoot, 'projects-memory', 'custom-root-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, 'MEMORY.md'),
        fm('md-custom-root-1', 'custom root project entry', '2026-05-11', '2026-05-11'),
        'utf-8',
      );

      const counters = await syncMarkdownMemories(
        customMemoryRepo, customGlobalDir, undefined, agentRoot, undefined, undefined, customCardStore,
      );

      assert.strictEqual(counters.projectCount, 1);
      // The mirror is md_id-keyed + project-blind (kind rows in the card store);
      // the pin here is that the ~/.pi/agent project scan still fires when the
      // global memoryDir lives elsewhere.
      const cards = await customCardStore.getCardsByKind('memory');
      assert.strictEqual(cards.length, 1);
      assert.strictEqual(cards[0].content, 'custom root project entry');
      assert.strictEqual(cards[0].id, 'md-custom-root-1');
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
      fm('md-inrepo-1', 'in-repo project convention'),
      'utf-8',
    );

    await syncMarkdownMemories(
      memoryRepo, globalDir, undefined, agentRoot,
      path.join(inRepoDir, 'MEMORY.md'),
      'demo-repo',
      await makeCardStore(),
    );

    // kp13 Wave B: the mirror lands as an md_id-keyed card row (project-blind —
    // project tagging rides the md layer / Wave C's Tier-1 reconciliation).
    const cards = await cardStore.getCardsByKind('memory');
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].content, 'in-repo project convention');
    assert.strictEqual(cards[0].id, 'md-inrepo-1');
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
      fm('md-split-legacy-1', 'legacy global project entry'),
      'utf-8',
    );

    // In-repo project entry (scanned via the inRepoProjectFile param).
    const inRepoDir = path.join(tmpDir, 'repo', '.agents', 'memory');
    fs.mkdirSync(inRepoDir, { recursive: true });
    fs.writeFileSync(
      path.join(inRepoDir, 'MEMORY.md'),
      fm('md-split-inrepo-1', 'in-repo project entry'),
      'utf-8',
    );

    await syncMarkdownMemories(
      memoryRepo, globalDir, undefined, agentRoot,
      path.join(inRepoDir, 'MEMORY.md'),
      projectName,
      await makeCardStore(),
    );

    // kp13 Wave B: both sources merge into the single card store (one kind,
    // distinct md_ids) — the split works end-to-end on the mirror seam.
    const cards = await cardStore.getCardsByKind('memory');
    assert.strictEqual(cards.length, 2);
    assert.deepStrictEqual(
      cards.map((c) => c.content).sort(),
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

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, await makeCardStore());

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

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, await makeCardStore());

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

    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, await makeCardStore());

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

  it('failure-state backfill reports counts + stoppedInjecting (Task 8 dry-run)', async () => {
    const failureEntry = serializeMetadataFrontmatter({
      id: 'rpt-fail-1', text: '[failure] live one', created: '2026-05-08', last: '2026-05-09',
    });
    const quirkEntry = serializeMetadataFrontmatter({
      id: 'rpt-quirk-1', text: '[tool-quirk] known quirk', created: '2026-05-08', last: '2026-05-09',
    });
    const resolvedEntry = serializeMetadataFrontmatter({
      id: 'rpt-resolved-1', text: '[failure] already fixed', created: '2026-05-08', last: '2026-05-09', state: 'resolved',
    });
    fs.writeFileSync(
      path.join(globalDir, 'failures.md'),
      [failureEntry, quirkEntry, resolvedEntry].join(ENTRY_DELIMITER),
      'utf-8',
    );

    const counters = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    const fstate = counters.failureState;
    assert.strictEqual(fstate.active, 1, '[failure] live one backfilled to active');
    assert.strictEqual(fstate.acquired, 1, '[tool-quirk] backfilled to acquired');
    assert.strictEqual(fstate.unchanged, 1, 'the resolved entry left untouched');
    // stoppedInjecting lists the acquired tool-quirk (was injecting, now won't) — NOT the active failure.
    assert.ok(fstate.stoppedInjecting.some((s) => s.includes('known quirk')), 'tool-quirk flagged as stopped injecting');
    assert.ok(!fstate.stoppedInjecting.some((s) => s.includes('live one')), 'active failure not flagged');
  });

  it('failure-state report is stable on a second (idempotent) run (Task 8)', async () => {
    fs.writeFileSync(
      path.join(globalDir, 'failures.md'),
      serializeMetadataFrontmatter({ id: 'rpt-idem-1', text: '[failure] once', created: '2026-05-08', last: '2026-05-09' }),
      'utf-8',
    );
    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot); // first run: active=1
    const counters = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot); // second run
    assert.strictEqual(counters.failureState.active, 0, 'nothing backfilled on the idempotent re-run');
    assert.strictEqual(counters.failureState.acquired, 0);
    assert.strictEqual(counters.failureState.unchanged, 1, 'the now-stateful entry counted as unchanged');
    assert.strictEqual(counters.failureState.stoppedInjecting.length, 0);
  });

  it('adds no dangling warning on a clean (no-supersession) store', async () => {
    // A normal multi-entry sync with no supersession produces no dangling refs —
    // regression guard so a future change can't silently start flagging
    // legitimate isolated entries.
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      'clean alpha <!-- created=2026-08-02, last=2026-08-02 -->' +
        ENTRY_DELIMITER +
        'clean beta <!-- created=2026-08-02, last=2026-08-02 -->',
      'utf-8',
    );
    const counters = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot);
    assert.ok(
      !counters.warnings.some((w) => w.includes('dangling')),
      `clean store should add no dangling warning, got: ${JSON.stringify(counters.warnings)}`,
    );
  });

  it('surfaces a dangling supersedes pointer after offload deletes the target (DO ticket 03)', async () => {
    // Reproduce the real rot: supersede A→B, then offload-delete A. B's row
    // survives with supersedes pointing at the now-absent A.id. Re-sync must
    // flag it on counters.warnings (and NOT re-import A, which has been removed
    // from the .md, mirroring offload's content-key purge).
    //
    // Frontmatter entries with an explicit `id` are used so the import stamps
    // md_id (comment-shape entries only get md_id via the separate
    // backfillStableIds session-start step, which this test does not run).
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      [
        serializeMetadataFrontmatter({ id: 'rot-alpha-1', text: 'rot alpha', created: '2026-08-02', last: '2026-08-02' }),
        serializeMetadataFrontmatter({ id: 'rot-beta-1', text: 'rot beta', created: '2026-08-02', last: '2026-08-02' }),
      ].join(ENTRY_DELIMITER),
      'utf-8',
    );
    await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, await makeCardStore());

    const rows = await memoryRepo.getMemories({ target: 'memory' });
    const A = rows.find((r) => r.content === 'rot alpha');
    const B = rows.find((r) => r.content === 'rot beta');
    assert.ok(A && B, 'precondition: both entries imported');

    await memoryRepo.supersedeMemory(A!.id, B!.id); // B.supersedes = A.id; A.status = superseded
    await memoryRepo.removeByMdId('rot-alpha-1', { target: 'memory' }); // offload-delete A → B dangles

    // Remove alpha from the .md so re-sync doesn't re-import it (offload also
    // purges the .md entry). B is unchanged → skipped (lineage untouched).
    fs.writeFileSync(
      path.join(globalDir, 'MEMORY.md'),
      serializeMetadataFrontmatter({ id: 'rot-beta-1', text: 'rot beta', created: '2026-08-02', last: '2026-08-02' }),
      'utf-8',
    );

    const counters = await syncMarkdownMemories(memoryRepo, globalDir, undefined, agentRoot, undefined, undefined, cardStore);
    assert.ok(
      counters.warnings.some((w) => w.includes('dangling') && w.includes(String(A!.id))),
      `expected a dangling warning citing missing id ${A!.id}, got: ${JSON.stringify(counters.warnings)}`,
    );
    assert.ok(
      counters.warnings.some((w) => w.includes('supersedes')),
      'the dangling field should be `supersedes`',
    );
  });
});

describe('syncMarkdownMemories dangling-reference sweep — robustness (DO ticket 03)', () => {
  // Isolated wire-in tests with a minimal mock repo. With no .md files present,
  // importEntries / backfillFailureState are no-ops, so only getMemories
  // (buildExistingIndex + the sweep) is exercised — proving the sweep's result
  // flows to counters.warnings and a thrown sweep is swallowed.
  let tmpDir: string;
  let globalDir: string;
  let agentRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-sweep-robustness-'));
    agentRoot = path.join(tmpDir, 'agent');
    globalDir = path.join(agentRoot, 'memory');
    fs.mkdirSync(globalDir, { recursive: true });
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function mockRepo(getMemoriesImpl: () => Promise<MemoryEntry[]>): MemoryRepository {
    return { getMemories: getMemoriesImpl } as unknown as MemoryRepository;
  }

  it('surfaces a dangling ref from the mock onto counters.warnings', async () => {
    const repo = mockRepo(async () => [
      {
        id: 10, target: 'memory', supersedes: 4242, project: null, category: null,
        content: 'x', failureReason: null, toolState: null, correctedTo: null,
        created: '', lastReferenced: '',
      } as MemoryEntry,
    ]);
    const counters = await syncMarkdownMemories(repo, globalDir, undefined, agentRoot);
    assert.ok(
      counters.warnings.some((w) => w.includes('dangling') && w.includes('4242')),
      `expected a dangling warning, got: ${JSON.stringify(counters.warnings)}`,
    );
  });

  it('swallows a thrown sweep without breaking sync', async () => {
    const repo = mockRepo(async () => {
      throw new Error('db unreachable');
    });
    // buildExistingIndex tolerates the same throw; the sweep must too. Sync
    // completes and returns its counters — never propagates.
    const counters = await syncMarkdownMemories(repo, globalDir, undefined, agentRoot);
    assert.ok(counters, 'sync must return counters even when getMemories throws');
    assert.ok(
      !counters.warnings.some((w) => w.includes('dangling')),
      'a throwing sweep must not emit dangling warnings',
    );
  });
});
