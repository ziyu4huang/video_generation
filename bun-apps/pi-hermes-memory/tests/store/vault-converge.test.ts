/**
 * Tests for the single-hop memory → vault convergence (Stage 2 of the
 * smart-knowledge-pipeline). Verifies:
 *   - entries converge to atomic zettel cards in the default vault;
 *   - the stable content-hash id makes re-convergence idempotent (no dupes);
 *   - graceful unavailable-fallback when pi-knowledge-card is absent.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convergeToVault } from "../../src/store/vault-converge.js";

describe("convergeToVault", () => {
  let tmpVault: string;
  let prevVaultPath: string | undefined;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-converge-test-"));
    // Tier-1a vault resolution: OB_VAULT_PATH (absolute, existing) wins.
    prevVaultPath = process.env.OB_VAULT_PATH;
    process.env.OB_VAULT_PATH = tmpVault;
  });

  afterEach(() => {
    if (prevVaultPath === undefined) delete process.env.OB_VAULT_PATH;
    else process.env.OB_VAULT_PATH = prevVaultPath;
    fs.rmSync(tmpVault, { recursive: true, force: true });
  });

  it("converges entries into atomic zettel cards in the default vault", async () => {
    const res = await convergeToVault(
      ["Bun workspaces use bun.lock, never package-lock.json."],
      "memory",
      tmpVault,
    );
    // In this workspace pi-knowledge-card is installed → happy path.
    assert.equal(res.ok, true);
    assert.equal(res.unavailable ?? false, false);
    assert.ok((res.created ?? 0) + (res.updated ?? 0) >= 1, "at least one card created");
    assert.ok(res.vaultPath === tmpVault);
    assert.equal(res.cards?.length, 1);
    // The card landed in the convergence folder.
    const kgDir = path.join(tmpVault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md") && n.startsWith("pi-memory-"));
    assert.ok(cards.length === 1, `expected 1 pi-memory card, got ${cards.length}`);
  });

  it("is idempotent: re-converging the same entry does not create a duplicate", async () => {
    const entry = "Stale config drift: OB_VAULT_PATH pointing at a ghost path falls through, not aborts.";
    const first = await convergeToVault([entry], "failure", tmpVault);
    assert.equal(first.ok, true);
    assert.equal(first.created, 1);

    // Re-converge the SAME entry → must upsert in place (unchanged), not a dupe.
    const second = await convergeToVault([entry], "failure", tmpVault);
    assert.equal(second.ok, true);
    assert.equal(second.created ?? 0, 0, "no NEW card on re-converge");
    assert.equal(second.updated ?? 0, 0, "content identical → not updated either");
    assert.equal(second.unchanged, 1);

    // Only one card on disk.
    const kgDir = path.join(tmpVault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md") && n.startsWith("pi-memory-"));
    assert.equal(cards.length, 1);
  });

  it("a different entry produces a DIFFERENT card (stable hash distinguishes content)", async () => {
    await convergeToVault(["First distinct durable fact about the environment."], "memory", tmpVault);
    await convergeToVault(["Second, completely different durable fact."], "memory", tmpVault);
    const kgDir = path.join(tmpVault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md") && n.startsWith("pi-memory-"));
    assert.equal(cards.length, 2, "two distinct entries → two cards");
  });

  it("empty entries list is a no-op (ok, zero cards)", async () => {
    const res = await convergeToVault([], "memory", tmpVault);
    assert.equal(res.ok, true);
    assert.equal(res.cards?.length ?? 0, 0);
  });
});
