/**
 * End-to-end test: drives the REAL `pi` CLI (not a mock) with the
 * planning-with-files extension loaded via `-e`, against a live model, and
 * asserts on the protocol event stream (`pi --mode json`) — deterministic
 * regardless of which model is used or how it responds.
 *
 * Gated on `RUN_E2E=1` AND a reachable provider so the default `bun test`
 * stays hermetic/fast. Run with:
 *   RUN_E2E=1 bun test tests/e2e            # auto-detects LM Studio / DeepSeek
 *   PI_E2E_PROVIDER=openai PI_E2E_MODEL=gpt-5 RUN_E2E=1 bun test tests/e2e
 *
 * The `before_agent_start` injection fires BEFORE the model responds, so the
 * asserts look for the injected content in the JSON stream and retry past
 * transient model-call crashes (non-zero exit) — the injection is observable
 * as long as the extension loaded and the turn started.
 *
 * Scenarios (each in a throwaway temp project):
 *  1. load    — extension registers without error; a turn reaches `agent_end`.
 *  2. inject  — PWF_AUTO_APPROVE=1 + an attested plan → before_agent_start
 *               injects the plan; the stream contains the plan's unique token
 *               + the `ACTIVE PLAN` marker. Proves injection reached the model.
 *  3. tamper  — mismatched attestation hash → injection blocked; the stream
 *               contains `PLAN TAMPERED` and must NOT contain the plan token.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.RUN_E2E === "1";
const PROVIDER = ENABLED ? detectProvider() : null;

const PKG_ROOT = join(import.meta.dir, "..", "..");
const PI_BIN = join(PKG_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const EXT = join(PKG_ROOT, "extensions", "index.ts");

const UNIQUE_TOKEN = "ZIGGY-PHALANX-77";
const PLAN_TEXT = [
  "# Mission",
  "",
  `Goal: deploy the ${UNIQUE_TOKEN} marble to production.`,
  "",
  "### Phase 1",
  "**Status:** complete",
  "",
  "### Phase 2",
  "**Status:** in_progress",
  "",
].join("\n");

const tempRoots: string[] = [];

function detectProvider(): { provider: string; model: string } | null {
  if (process.env.PI_E2E_PROVIDER && process.env.PI_E2E_MODEL) {
    return { provider: process.env.PI_E2E_PROVIDER, model: process.env.PI_E2E_MODEL };
  }
  // Prefer the offline local model when available — the e2e asserts on the
  // injection protocol stream (not the model's prose), so a small local model
  // is sufficient AND avoids cloud network/rate-limit flakiness.
  const lm = spawnSync("curl", ["-sS", "-m", "2", "http://127.0.0.1:1234/v1/models"], {
    encoding: "utf-8",
  });
  if (lm.status === 0 && /gemma/i.test(lm.stdout)) {
    return { provider: "lm-studio", model: "google/gemma-4-26b-a4b-qat" };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { provider: "deepseek", model: "deepseek-v4-flash" };
  }
  return null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-e2e-"));
  tempRoots.push(cwd);
  return cwd;
}

function writeScopedPlan(cwd: string, plan: string, attestationHash: string | null): void {
  const dir = join(cwd, ".planning", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task_plan.md"), plan);
  if (attestationHash !== null) {
    writeFileSync(join(dir, ".attestation"), `${attestationHash}\n`);
  }
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPiOnce(cwd: string, prompt: string, env: Record<string, string>): RunResult {
  const provider = PROVIDER;
  if (!provider) throw new Error("runPi called without a resolved e2e provider");
  const args = [
    PI_BIN,
    "-e",
    EXT,
    "--provider",
    provider.provider,
    "--model",
    provider.model,
    "--no-session",
    "--no-tools",
    "--thinking",
    "off",
    "--mode",
    "json",
    "-p",
    prompt,
  ];
  const result = spawnSync("bun", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Run pi, retrying until `ok(stdout)` passes (or attempts run out). Tolerates
 * transient model-call crashes: the injection is emitted to the stream before
 * the model responds, so a crashed run can still satisfy the predicate.
 */
function runPiUntil(
  cwd: string,
  prompt: string,
  env: Record<string, string>,
  ok: (stdout: string) => boolean,
  attempts = 3,
): RunResult {
  let last: RunResult = { status: -1, stdout: "", stderr: "" };
  for (let i = 0; i < attempts; i++) {
    last = runPiOnce(cwd, prompt, env);
    if (ok(last.stdout)) return last;
  }
  return last;
}

describe.skipIf(!PROVIDER)("e2e: pi CLI drives the planning-with-files extension", () => {
  it("scenario 1 — extension loads + a trivial turn reaches agent_end", () => {
    const cwd = makeProject();
    const r = runPiUntil(cwd, "Reply with exactly: PONG", {}, (s) => s.includes('"type":"agent_end"'));
    expect(r.stdout).toContain('"type":"agent_end"');
  }, 240_000);

  it("scenario 2 — attested + auto-approved plan injects into the conversation stream", () => {
    const cwd = makeProject();
    writeScopedPlan(cwd, PLAN_TEXT, sha256(PLAN_TEXT));
    const r = runPiUntil(
      cwd,
      "Say OK.",
      { PWF_AUTO_APPROVE: "1", PWF_MODE: "parity" },
      (s) => s.includes("ACTIVE PLAN") && s.includes(UNIQUE_TOKEN),
    );
    // The before_agent_start custom message carrying the plan appears in the
    // JSON event stream — proving the Layer-3 injection reached the model
    // context, independent of how the model chose to respond.
    expect(r.stdout).toContain("ACTIVE PLAN");
    expect(r.stdout).toContain(UNIQUE_TOKEN);
  }, 240_000);

  it("scenario 3 — mismatched attestation blocks injection (PLAN TAMPERED, no token)", () => {
    const cwd = makeProject();
    writeScopedPlan(cwd, PLAN_TEXT, "0".repeat(64));
    const r = runPiUntil(
      cwd,
      "Say OK.",
      { PWF_AUTO_APPROVE: "1", PWF_MODE: "parity" },
      (s) => s.includes("PLAN TAMPERED") && !s.includes(UNIQUE_TOKEN),
    );
    // Injection blocked: the tamper warning is injected instead of the plan,
    // and the plan's unique token must NOT appear anywhere in the stream.
    expect(r.stdout).toContain("PLAN TAMPERED");
    expect(r.stdout).not.toContain(UNIQUE_TOKEN);
  }, 240_000);
});

// Ensure temp projects are cleaned up even if a test throws mid-suite.
process.on("exit", () => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});
