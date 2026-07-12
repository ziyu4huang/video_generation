import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zkRetrieve, zkIngest, zkHealth, zkHeal, buildRetrieveOptions } from "../src/host-fns.js";
import { retrieveRecords } from "../src/retrieve.js";

const mkctx = (vaultPath: string) => ({ cwd: "/", signal: new AbortController().signal, runId: "test", vaultPath });
const tmpVault = () => mkdtempSync(join(tmpdir(), "kc-hostfn-"));

describe("zk.retrieve", () => {
  it("parity: same count + digest as retrieveRecords on identical opts", async () => {
    const vault = tmpVault();
    try {
      const args = { tags: ["flux2"], topK: 5, semantic: false } as const;
      const direct = await retrieveRecords(buildRetrieveOptions(args as any, vault));
      const viaFn: any = await zkRetrieve(args as any, mkctx(vault));
      assert.equal(viaFn.count, direct.count);
      assert.equal(viaFn.digest, direct.digest);
      assert.equal(viaFn.scanned, direct.scanned);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("zk.ingest", () => {
  it("ingests a .knowledge.jsonl fixture and reports created=1", async () => {
    const vault = tmpVault();
    const dir = mkdtempSync(join(tmpdir(), "kc-src-"));
    writeFileSync(
      join(dir, "f.knowledge.jsonl"),
      JSON.stringify({ id: "t1", type: "gotcha", title: "T", detail: "d", tags: ["x"] }) + "\n",
    );
    try {
      const summary: any = await zkIngest({ dir, source: "workflow-jsonl" }, mkctx(vault));
      assert.equal(summary.created, 1);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zk.health / zk.heal", () => {
  it("zk.health returns { health, text } with the GraphHealthResult shape", async () => {
    const vault = tmpVault();
    try {
      const out: any = await zkHealth({ folder: "Zettelkasten/knowledge-graph" }, mkctx(vault));
      assert.ok(typeof out.text === "string");
      assert.ok("deadLinks" in out.health && "mocMissing" in out.health && "cardCount" in out.health);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  it("zk.heal returns the HealResult shape", async () => {
    const vault = tmpVault();
    try {
      const out: any = await zkHeal({ folder: "Zettelkasten/knowledge-graph" }, mkctx(vault));
      assert.ok("mocRegenerated" in out && "deadLinksPruned" in out && "cardsTouched" in out);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
