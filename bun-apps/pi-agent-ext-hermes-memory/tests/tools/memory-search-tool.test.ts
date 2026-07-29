import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteBackend } from '../../src/store/sqlite/sqlite-backend.js';
import { SqliteMemoryRepository } from '../../src/store/sqlite/sqlite-memory-repo.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';
import { RecallSet } from '../../src/handlers/worth-scoring.js';

let ROOT_DIR = '';
let backend: SqliteBackend | null = null;

afterEach(async () => {
  if (backend) { await backend.close(); backend = null; }
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = '';
});

function makeRepo(): SqliteMemoryRepository {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-search-tool-test-'));
  backend = new SqliteBackend(ROOT_DIR);
  return new SqliteMemoryRepository(backend);
}

describe('registerMemorySearchTool', () => {
  it('returns a broader natural-language match when strict term matching misses', async () => {
    const memoryRepo = makeRepo();
    await memoryRepo.addMemory({ content: "user's name is Naruto", target: 'user' });

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, memoryRepo);

    const result = await captured.execute('tc-1', { query: 'name identity Naruto', target: 'user' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);
  });

  it('bumps last_referenced for matched entries (touch-on-search wiring)', async () => {
    const memoryRepo = makeRepo();
    const old = '2020-01-01';
    const added = await memoryRepo.addMemory({
      content: "user's name is Naruto",
      target: 'user',
      created: old,
      lastReferenced: old,
    });
    assert.strictEqual(added.lastReferenced, old, 'precondition: last_referenced starts old');

    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    registerMemorySearchTool(mockPi, memoryRepo);

    const result = await captured.execute('tc-touch', { query: 'name identity Naruto', target: 'user' });
    assert.strictEqual(result.details.success, true);

    // After search, last_referenced must be bumped to today (the live 'last surfaced' signal)
    const row = backend!.getDb().prepare('SELECT created, last_referenced FROM memories WHERE id = ?').get(added.id) as { created: string; last_referenced: string };
    const todayStr = new Date().toISOString().split('T')[0];
    assert.strictEqual(row.last_referenced, todayStr, 'search bumped last_referenced to today');
    assert.strictEqual(row.created, old, 'created is preserved (not mutated by touch)');
  });

  it('records recalled ids into the recall-set (memory_search → worth producer wiring)', async () => {
    const memoryRepo = makeRepo();
    await memoryRepo.addMemory({ content: "user's name is Naruto", target: 'user' });
    const recallSet = new RecallSet();

    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    registerMemorySearchTool(mockPi, memoryRepo, recallSet);

    await captured.execute('tc-recall', { query: 'name identity Naruto', target: 'user' });

    // The recalled entry's id must be recorded into the shared recall-set so
    // setupWorthScoring can later bump its mw_success/mw_fail at turn_end.
    const drained = recallSet.drain();
    assert.ok(drained.length > 0, 'at least the recalled entry was recorded');
  });
});
