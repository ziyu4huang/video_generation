import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point pi's ProjectTrustStore at a temp store that trusts EVERYTHING
 * (`/` → true), for test files whose fixtures use synthetic cwds ("/repo",
 * fake homes) alongside project-sourced agentTypes. Without this, the arc-26
 * store-backed default gate denies those defs for a reason the test is not
 * about — trust SEMANTICS are pinned in agent-trust.test.ts via explicit
 * agentDir fixtures, not here.
 *
 * Idempotent per process (`??=`): the first caller wins, and files that need
 * a specific store pass `agentDir` explicitly instead.
 */
export function installSyntheticTrustRoot(): void {
  if (process.env.PI_CODING_AGENT_DIR) return;
  const dir = mkdtempSync(join(tmpdir(), "trust-fixture-"));
  writeFileSync(join(dir, "trust.json"), JSON.stringify({ "/": true }));
  process.env.PI_CODING_AGENT_DIR = dir;
}
