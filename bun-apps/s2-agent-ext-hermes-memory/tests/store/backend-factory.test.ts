/**
 * Tests for createBackendBundleWithFallback — the startup resilience path.
 *
 * Root cause (#start-fallback bug): the initial backend bundle creation in
 * index.ts was uncaught, so a down/missing SurrealDB server (dbBackend:
 * "surrealdb" in hermes-memory-config.json) threw during extension load and
 * aborted agent startup ("Failed to load extension … SurrealDB request
 * failed: Unable to connect"). The fix: if the configured backend cannot
 * initialize, fall back to sqlite (local file, no server) so a missing
 * external service never blocks the agent from starting.
 */
import { describe, it, beforeEach, afterEach } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackendBundleWithFallback } from "../../src/store/backend-factory.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";

describe("createBackendBundleWithFallback", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backend-fallback-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("falls back to sqlite when the configured surrealdb backend is unreachable", async () => {
    // Port 1 has no listener → immediate ECONNREFUSED; init() throws fast
    // (3 retries × ~100-200ms backoff ≈ well under 1s). A down SurrealDB
    // server must NOT block agent startup.
    const result = await createBackendBundleWithFallback(
      { dbBackend: "surrealdb", surreal: { endpoint: "http://127.0.0.1:1" } } as any,
      tmpDir,
    );
    assert.equal(result.fellBackTo, "sqlite");
    assert.ok(result.bundle.backend instanceof SqliteBackend, "fell back to a sqlite backend");
  });

  it("returns the configured backend with no fallback when it initializes cleanly", async () => {
    const result = await createBackendBundleWithFallback({ dbBackend: "sqlite" } as any, tmpDir);
    assert.equal(result.fellBackTo, null);
    assert.ok(result.bundle.backend instanceof SqliteBackend);
  });
});
