import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveKnowledgeVaultPath, KNOWLEDGE_FOLDER_DEFAULT, KNOWLEDGE_MOC_DEFAULT } from "./knowledge-vault-path.js";

describe("resolveKnowledgeVaultPath (env-only)", () => {
  let vaultA: string;
  let vaultB: string;

  beforeEach(() => {
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    vaultA = mkdtempSync(join(tmpdir(), "kvault-a-"));
    vaultB = mkdtempSync(join(tmpdir(), "kvault-b-"));
  });

  afterEach(() => {
    rmSync(vaultA, { recursive: true, force: true });
    rmSync(vaultB, { recursive: true, force: true });
  });

  it("prefers KNOWLEDGE_VAULT_PATH over OB_VAULT_PATH", () => {
    process.env.KNOWLEDGE_VAULT_PATH = vaultA;
    process.env.OB_VAULT_PATH = vaultB;
    assert.equal(resolveKnowledgeVaultPath(), vaultA);
  });

  it("falls back to OB_VAULT_PATH when KNOWLEDGE_VAULT_PATH unset", () => {
    process.env.OB_VAULT_PATH = vaultB;
    assert.equal(resolveKnowledgeVaultPath(), vaultB);
  });

  it("throws a clear error when both unset", () => {
    assert.throws(() => resolveKnowledgeVaultPath(), /KNOWLEDGE_VAULT_PATH|OB_VAULT_PATH/);
  });

  it("throws a clear error when the resolved path does not exist", () => {
    process.env.KNOWLEDGE_VAULT_PATH = "/definitely/not/a/real/vault/path/12345";
    assert.throws(() => resolveKnowledgeVaultPath(), /does not exist/);
  });

  it("default folder is Zettelkasten/knowledge-graph", () => {
    assert.equal(KNOWLEDGE_FOLDER_DEFAULT, "Zettelkasten/knowledge-graph");
  });

  it("default MOC is Tags/Knowledge Graph.md", () => {
    assert.equal(KNOWLEDGE_MOC_DEFAULT, "Tags/Knowledge Graph.md");
  });
});
