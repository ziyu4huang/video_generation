// tests/watchdog-lsp-diagnostics.test.ts

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runLspDiagnostics } from "../src/watchdog/lsp-diagnostics.js";

describe("lsp-diagnostics", () => {
  it("returns ran:false with a note when no TS/JS paths", async () => {
    const r = await runLspDiagnostics({ root: process.cwd(), changedPaths: ["README.md"] });
    assert.equal(r.ran, false);
    assert.match(r.note ?? "", /no changed typescript/i);
    assert.deepEqual(r.findings, []);
  });
  it("degrades gracefully when the language server is unavailable", async () => {
    // A bogus root with node_modules/.bin absent + PATH unreachable via env override.
    const r = await runLspDiagnostics({ root: "/nonexistent-root-xyz", changedPaths: ["a.ts"] });
    assert.equal(r.ran, false);
    assert.ok(r.note);
  });
});
