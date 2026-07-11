/**
 * Tests for passive session-end convergence (the tight-pipeline loop closure).
 *
 * Covers the Alluvium regression contracts:
 *   - shutdown_converge_passive: new entries → vault cards with NO manual transfer
 *   - hook_idempotent: re-run converges the same entries to unchanged, not duplicates
 *   - concurrent_sessions: two stores capturing the same lesson → one card
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { passiveConverge } from "../../src/handlers/passive-converge.js";
import {
  loadHealth,
  loadConvergeState,
  computeReconciliation,
  HEALTH_FILENAME,
} from "../../src/store/converge-health.js";

let vault: string;
let stateDir: string;
let prevVaultPath: string | undefined;

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "passive-e2e-"));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "passive-state-"));
  prevVaultPath = process.env.OB_VAULT_PATH;
  process.env.OB_VAULT_PATH = vault;
});
afterEach(() => {
  if (prevVaultPath === undefined) delete process.env.OB_VAULT_PATH;
  else process.env.OB_VAULT_PATH = prevVaultPath;
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A minimal mock store implementing the three entry getters. */
function mockStore(entries: {
  failure?: string[];
  memory?: string[];
  user?: string[];
}) {
  return {
    getAllFailureEntries: () => [...(entries.failure ?? [])],
    getMemoryEntries: () => [...(entries.memory ?? [])],
    getUserEntries: () => [...(entries.user ?? [])],
  };
}

describe("passive-converge — shutdown loop closure", () => {
  it("shutdown_converge_passive: captured entries → vault cards (no manual transfer)", async () => {
    const store = mockStore({
      failure: [
        "MLX venv at python/venv must be recreated with uv after a fresh clone.",
      ],
      memory: ["Project uses bun.lock as the canonical lockfile."],
    });

    // Simulate session_shutdown → passiveConverge fires.
    const result = await passiveConverge(store, vault, stateDir, "test-project");

    assert.equal(result.converged, 2, "both entries converged");
    assert.equal(result.skipped, 0);
    assert.equal(result.timedOut, false);

    // Cards exist in the vault — NO manual `memory transfer` was needed.
    const kgDir = path.join(vault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md"));
    assert.ok(cards.length >= 2, "vault gained cards passively");
  });

  it("hook_idempotent: re-run converges the same entries to skipped, not duplicates", async () => {
    const store = mockStore({
      failure: ["A durable lesson about the build system venv."],
    });

    // First run: converges.
    const r1 = await passiveConverge(store, vault, stateDir);
    assert.equal(r1.converged, 1);

    // Second run: SAME entries → all skipped (idempotent).
    const r2 = await passiveConverge(store, vault, stateDir);
    assert.equal(r2.converged, 0, "no re-convergence of unchanged entries");
    assert.equal(r2.skipped, 1);

    // Still one card (no duplicate from the re-run).
    const kgDir = path.join(vault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md"));
    assert.equal(cards.length, 1, "idempotent — still one card");
  });

  it("new entries on a later run are converged (delta detection)", async () => {
    const failures = ["First lesson captured in session A."];
    const store = mockStore({ failure: failures });

    const r1 = await passiveConverge(store, vault, stateDir);
    assert.equal(r1.converged, 1);

    // Session B captures a NEW entry.
    failures.push("Second lesson captured in session B.");
    const r2 = await passiveConverge(store, vault, stateDir);
    assert.equal(r2.converged, 1, "only the new entry converged");
    assert.equal(r2.skipped, 1, "the old entry was skipped");
  });

  it("concurrent_sessions: two stores with the same lesson → one card (wiki-aware)", async () => {
    const lesson =
      "Bun workspace monorepo uses isolated linker with globalStore for package resolution; bun.lock is canonical.";

    // Two independent stores (simulating two concurrent sessions) both capture
    // the same lesson under different targets.
    const storeA = mockStore({ failure: [lesson] });
    const storeB = mockStore({ memory: [lesson] });

    // Session A converges.
    await passiveConverge(storeA, vault, stateDir, "proj");

    // Session B converges the same lesson from a different namespace.
    await passiveConverge(storeB, vault, stateDir, "proj");

    // The wiki-aware matcher should have reused the canonical card → ONE card.
    const kgDir = path.join(vault, "Zettelkasten", "knowledge-graph");
    const cards = fs.readdirSync(kgDir).filter((n) => n.endsWith(".md"));
    assert.equal(cards.length, 1, "two sessions, same lesson → one canonical card");
  });

  it("noise-only session converges nothing", async () => {
    // A store with zero entries → convergence does nothing.
    const store = mockStore({});
    const result = await passiveConverge(store, vault, stateDir);
    assert.equal(result.converged, 0, "empty store converges nothing");
  });

  // ── Phase 1.2: convergence health observability ──────────────────────────
  it("writes a health record after a successful run (no more silent failure)", async () => {
    const store = mockStore({
      failure: ["A lesson that should converge cleanly."],
      memory: ["And a second one under memory."],
    });

    await passiveConverge(store, vault, stateDir, "test-project");

    // The health file exists and records an OK run.
    assert.ok(fs.existsSync(path.join(stateDir, HEALTH_FILENAME)), "health file written");
    const health = loadHealth(stateDir);
    assert.ok(health.latest, "latest run present");
    assert.equal(health.latest!.overall, "ok");
    assert.equal(health.latest!.triggeredBy, "passive");
    assert.equal(health.latest!.timedOut, false);
    // Both targets reported with non-zero seen counts.
    const failTarget = health.latest!.targets.find((t) => t.target === "failure");
    const memTarget = health.latest!.targets.find((t) => t.target === "memory");
    assert.equal(failTarget?.seen, 1);
    assert.equal(failTarget?.status, "ok");
    assert.equal(memTarget?.seen, 1);
    assert.equal(memTarget?.status, "ok");
  });

  it("live reconciliation reports zero unconverged after convergence", async () => {
    const entries = { failure: ["Reconciled lesson about the venv layout."] };
    await passiveConverge(mockStore(entries), vault, stateDir);

    const state = loadConvergeState(stateDir);
    const recon = computeReconciliation(entries, state);
    assert.equal(recon[0].unconverged, 0, "entry now shows as converged");
    assert.equal(recon[0].converged, 1);
  });

  it("live reconciliation flags an unconverged entry (the silent-failure signal)", async () => {
    // Converge one entry, then add a NEW one without converging it.
    const entries = { memory: ["First converged entry."] };
    await passiveConverge(mockStore(entries), vault, stateDir);

    entries.memory.push("Second entry that was NEVER converged.");
    const recon = computeReconciliation(entries, loadConvergeState(stateDir));
    assert.equal(recon[0].unconverged, 1, "the new entry is flagged");
    assert.equal(recon[0].total, 2);
  });
});
