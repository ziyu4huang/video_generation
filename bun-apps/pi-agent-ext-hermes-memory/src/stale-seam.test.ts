// src/stale-seam.test.ts — hermes PUBLISHER of the staleness reverse seam (T7).
//
// node:test + node:assert/strict (co-located with src/stale-seam.ts, mirroring
// src/store/planning-staleness.test.ts). Exercises the published async reader
// against a REAL ephemeral CardStore + a REAL source .md (Path B, decision η):
// the seam fn must surface a card whose dep drifted, clear on unpublish, and
// degrade to { stale: [] } (never throw) when the store dir is missing.
import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createCardStore } from "./store/card-store.js";
import { computeStaleness } from "./store/planning-staleness.js";
import { HERMES_STALE_CHECK_KEY, publishStaleCheck, unpublishStaleCheck } from "./stale-seam.js";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY];
});

/** Write a dep file under root (creating its parent dir). */
function writeDep(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Write a source .md ticket that cites `citesPath` in the body + declares
 *  `depends_on: <depPath>` in frontmatter, plus writes BOTH dep files (v1).
 *  ticketCard() emits a `cites` + a `depends_on` relation -> citedDeps =
 *  [citesPath, depPath]. Returns the ticket card id. (Mirrors the committed
 *  T4 seedSource idiom — Path B: deps come from the source .md, NOT the store.) */
function seedSource(root: string, effort: string, citesPath: string, depPath: string): string {
  const ticketPath = join(root, ".planning", effort, "tickets", "01-seam-ticket.md");
  mkdirSync(dirname(ticketPath), { recursive: true });
  writeFileSync(
    ticketPath,
    `---\ntype: task\nstatus: closed\ndepends_on: ${depPath}\n---\n# 01 — seam-ticket\n\n## Resolution\n\nThis decision cites ${citesPath} in the body.\n`,
  );
  writeDep(root, citesPath, "v1");
  writeDep(root, depPath, "v1");
  return `planning-ticket:${effort}:01`;
}

describe("publishStaleCheck (10-impl T7 — hermes side)", () => {
  it("publishes an async (effort, cwd) => { stale } reader under globalThis that surfaces a drifted card", async () => {
    const root = mkdtempSync(join(tmpdir(), "seam-h-root-"));
    const mem = mkdtempSync(join(tmpdir(), "seam-h-mem-"));
    try {
      // Path B: write the source .md + both dep files, upsert the id for
      // getStaleCards enumeration, then seed the baseline @ v1.
      const id = seedSource(root, "seam", "src/seam-cites.ts", "src/seam-dep.ts");
      const store = await createCardStore({ memoryDir: mem });
      await store.upsertCard({ id, kind: "planning-ticket", content: "", frontmatter: { id: "01" } });
      await computeStaleness(store, id, root); // seed baseline (clean)
      await store.close();
      // drift the cited dep -> the card is now stale against the seeded baseline.
      writeFileSync(join(root, "src", "seam-cites.ts"), "v2-EDITED");

      publishStaleCheck(mem);
      const fn = (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY];
      assert.equal(typeof fn, "function");
      const r = await (fn as (e: string, cwd: string) => Promise<{ stale: { cardId: string }[] }>)("seam", root);
      assert.ok(r.stale.some((s) => s.cardId === id), "the drifted card surfaces via the seam");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("unpublishStaleCheck clears the global", () => {
    publishStaleCheck("/nonexistent");
    assert.equal(typeof (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY], "function");
    unpublishStaleCheck();
    assert.equal((globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY], undefined);
  });

  it("degrades to { stale: [] } (never throws) when the store cannot open", async () => {
    // A memoryDir that does not exist: createCardStore will throw trying to
    // open the SQLite file (parent dir absent). The published fn MUST swallow
    // that and return { stale: [] } so a wayfind graduation never false-blocks.
    publishStaleCheck("/nonexistent/missing-dir/under/missing-parent");
    const fn = (globalThis as Record<string, unknown>)[HERMES_STALE_CHECK_KEY] as (
      e: string,
      cwd: string,
    ) => Promise<{ stale: unknown[] }>;
    const r = await fn("any", "/nonexistent");
    assert.deepEqual(r.stale, []);
  });
});
