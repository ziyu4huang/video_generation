import { describe, it } from "bun:test";
import assert from "node:assert/strict";

// ticket 10 reconciliation kill-switches: zkRetrieve opts into the usage
// ledger and zkIngest into the post-write index rebuild (both production
// boundaries) — this suite never writes the real ledger, nor swaps the
// live index, from a temp vault.
process.env.KCARD_USAGE_LOG = "0";
process.env.KCARD_INDEX_REBUILD = "0";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zkRetrieve, zkIngest, zkHealth, zkHeal, buildRetrieveOptions } from "../src/host-fns.js";
import { retrieveRecords } from "../src/retrieve.js";
import { coverageReport } from "../src/ingest.js";
import { resolveSpecsToRecords } from "../src/source-watchlist.js";
import piKnowledgeCardExtension from "../extensions/knowledge-card.ts";

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

describe("knowledge-card host-fn registration (event bus)", () => {
  /** Minimal ExtensionAPI double with just the surface the registration uses. */
  function mkPi() {
    const handlers: Record<string, Array<(p: unknown) => void>> = {};
    const emitted: Array<{ channel: string; payload: any }> = [];
    const pi: any = {
      registerTool() {},
      on() {},
      registerCommand() {},
      events: {
        on(ch: string, cb: (p: unknown) => void) {
          (handlers[ch] ??= []).push(cb);
        },
        emit(ch: string, p: unknown) {
          emitted.push({ channel: ch, payload: p });
          for (const cb of handlers[ch] ?? []) cb(p);
        },
      },
    };
    return { pi, emitted, fire: (ch: string) => { for (const cb of handlers[ch] ?? []) cb({}); } };
  }

  it("emits workflow:hostfn:v1:register for all four zk.* fns on load", () => {
    const { pi, emitted } = mkPi();
    piKnowledgeCardExtension(pi);
    const registered = emitted
      .filter((e) => e.channel === "workflow:hostfn:v1:register")
      .map((e) => `${e.payload.ns}.${e.payload.name}`);
    assert.deepEqual(registered.sort(), ["zk.heal", "zk.health", "zk.ingest", "zk.retrieve"]);
    for (const e of emitted.filter((x) => x.channel === "workflow:hostfn:v1:register")) {
      assert.equal(typeof e.payload.fn, "function", `${e.payload.name} carries a fn`);
    }
  });

  it("re-emits registrations on workflow:hostfn:v1:request (load-order robust)", () => {
    const { pi, emitted, fire } = mkPi();
    piKnowledgeCardExtension(pi);
    const afterLoad = emitted.filter((e) => e.channel === "workflow:hostfn:v1:register").length;
    assert.ok(afterLoad >= 4, "eager registration on load");
    fire("workflow:hostfn:v1:request");
    const afterRequest = emitted.filter((e) => e.channel === "workflow:hostfn:v1:register").length;
    assert.ok(afterRequest > afterLoad, "re-emitted registrations on request");
  });
});

describe("zk.health coverage", () => {
  it("coverage:true populates health.coverage with the missing set", async () => {
    const vault = tmpVault();
    const seedDir = mkdtempSync(join(tmpdir(), "kc-cov-seed-"));
    const srcDir = mkdtempSync(join(tmpdir(), "kc-cov-src-"));
    // Seed the vault with ONLY wf:a.
    writeFileSync(
      join(seedDir, "seed.knowledge.jsonl"),
      JSON.stringify({ id: "wf:a", type: "gotcha", title: "A", detail: "d", tags: ["x"] }) + "\n",
    );
    // Coverage source has wf:a (converged) + wf:b (NOT converged).
    writeFileSync(
      join(srcDir, "src.knowledge.jsonl"),
      JSON.stringify({ id: "wf:a", type: "gotcha", title: "A", detail: "d", tags: ["x"] }) + "\n" +
      JSON.stringify({ id: "wf:b", type: "gotcha", title: "B", detail: "d", tags: ["x"] }) + "\n",
    );
    try {
      await zkIngest({ files: [join(seedDir, "seed.knowledge.jsonl")], source: "workflow-jsonl" }, mkctx(vault));
      const viaFn: any = await zkHealth(
        { coverage: true, sources: [{ family: "workflow-jsonl", files: [join(srcDir, "src.knowledge.jsonl")] }] },
        mkctx(vault),
      );
      assert.ok(viaFn.health.coverage, "coverage populated when coverage:true");
      assert.deepEqual(viaFn.health.coverage.missing, ["wf:b"]);
      assert.deepEqual(viaFn.health.coverage.sourceOrphaned, []);
      assert.equal(viaFn.health.coverage.byFamily["workflow-jsonl"].matched, 1);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it("parity: health.coverage == direct coverageReport on identical sources (host-fn honesty)", async () => {
    const vault = tmpVault();
    const srcDir = mkdtempSync(join(tmpdir(), "kc-cov-par-"));
    writeFileSync(
      join(srcDir, "src.knowledge.jsonl"),
      JSON.stringify({ id: "wf:a", type: "gotcha", title: "A", detail: "d", tags: ["x"] }) + "\n" +
      JSON.stringify({ id: "wf:c", type: "gotcha", title: "C", detail: "d", tags: ["x"] }) + "\n",
    );
    try {
      const specs = [{ family: "workflow-jsonl" as const, files: [join(srcDir, "src.knowledge.jsonl")] }];
      const resolved = await resolveSpecsToRecords(specs, "/");
      const direct = await coverageReport({ vaultPath: vault, sources: resolved });
      const viaFn: any = await zkHealth({ coverage: true, sources: specs }, mkctx(vault));
      assert.deepEqual(viaFn.health.coverage, direct);
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it("coverage omitted → health.coverage undefined (backward-compatible)", async () => {
    const vault = tmpVault();
    try {
      const viaFn: any = await zkHealth({}, mkctx(vault));
      assert.equal(viaFn.health.coverage, undefined);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
