/**
 * l2-e2e.test.ts — L2 regression e2e for s2-agent-ext-power-tool.
 *
 * WHAT THIS TESTS (vs the L0/L1 power-tool unit test):
 *   L0 — unit tests: mock ExtensionAPI, call execute() directly.
 *   L1 — this file: spawn the REAL s2-agent CLI as a subprocess, load the
 *        power-tool extension, invoke each tool through the actual agent
 *        session pipeline. No mock, no workflow engine, no LLM subagent.
 *   L2 — the `workflow` path is deprecated: the previous approach used a
 *        workflow `agent()` subagent to run bash (fragile, non-deterministic,
 *        hard to debug). This file REPLACES it with deterministic subprocess
 *        assertions.
 *
 * DETERMINISM:
 *   Every tool invocation is a child process (Bun.spawnSync). The exit code
 *   is checked directly. Content markers are checked with case-insensitive
 *   substring matching on stdout. There is no LLM interpretation layer — the
 *   only LLM involvement is the model loaded inside each CLI invocation to
 *   generate the tool response. This means the test IS non-deterministic at
 *   the tool-output level (different model runs produce different prose), but
 *   the verification logic is 100% deterministic.
 *
 * REQUIREMENTS:
 *   - LM Studio running on localhost:1234 with google/gemma-4-12b
 *     loaded (or a different model configured via PI_L2_MODEL)
 *
 *     PORTABILITY PITFALL (found live 2026-08-18): a user-level
 *     `defaultProvider` in ~/.pi/agent/settings.json (e.g. "zai") SILENTLY
 *     HIJACKS a provider-less `--model` value - the request goes to that
 *     provider and 400s ("modelCode: does not exist") even though the same
 *     model id is properly registered in ~/.pi/agent/models.json under
 *     another provider (lm-studio). Set PI_L2_PROVIDER (e.g. "lm-studio")
 *     to append an explicit `--provider` flag and make the spawn immune.
 *   - s2-agent dependencies installed (bun install at repo root)
 *   - Model inference per tool: ~5-15s (warming) + ~2-5s (steady)
 *
 * RUN (from repo root):
 *   bun test bun-apps/s2-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts
 *
 * RUN all power-tool tests:
 *   ( cd bun-apps/s2-agent-ext-power-tool && bun test )
 *
 * OPT-IN: L2 tests are SKIPPED by default. They spawn the real s2-agent CLI
 * and load a real model from LM Studio — each takes up to 30s, far over
 * bun:test's 5s default timeout. Enable explicitly:
 *   PI_RUN_L2=1 bun test bun-apps/s2-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts
 * If a required service is unreachable the test SKIPS with a reason in its title
 * (no spurious 5s-timeout failure). PI_SKIP_L2=1 (legacy) is still honored as a
 * force-skip.
 */

import { test, expect } from "bun:test";
import { resolveTestMode } from "./l2-test-mode";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

// ─── Constants ───────────────────────────────────────────────────────────────

// Resolve repo root by walking up from this file to find bun-apps/ — works
// regardless of whether the test is run from the repo root or from the package dir.
function findRepoRoot(from: string): string {
	let dir = from;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, "bun-apps"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return from; // fallback to input dir if bun-apps/ not found
}

const FILE_DIR = resolve(import.meta.dirname ?? process.cwd());
const REPO_ROOT = findRepoRoot(FILE_DIR);
const CLI = `${REPO_ROOT}/bun-apps/s2-agent/src/cli.ts`;
const EXT = `${REPO_ROOT}/bun-apps/s2-agent-ext-power-tool/extensions/power-tool.ts`;
const MODEL = process.env.PI_L2_MODEL || "google/gemma-4-12b";
// Optional explicit provider (see the pitfall note above): when set, the CLI
// spawn carries `--provider <PI_L2_PROVIDER>` so a user-level defaultProvider
// cannot hijack the model resolution. Unset = legacy behavior (bare --model).
const PROVIDER = process.env.PI_L2_PROVIDER || "";

// Each tool: prompt to invoke it + expected-content markers (case-insensitive).
// An empty markers array = content-agnostic (exit 0 is the gate).
interface ToolEntry {
  name: string;
  prompt: string;
  markers: string[];
  /** Subprocess timeout in ms (default 120_000). */
  timeoutMs?: number;
}

const TOOLS: ToolEntry[] = [
  {
    name: "inspect_context",
    prompt: "call inspect_context --self-test true",
    // Tool name in backticks survives LLM translation reliably.
    markers: ["inspect_context"],
    // Self-test mode: still needs model inference for prompt→tool routing,
    // but returns immediately once the tool is invoked. Short timeout so a
    // non-responsive model fails fast rather than hanging.
    timeoutMs: 30_000,
  },
  {
    name: "inspect_agent",
    prompt: "call inspect_agent --self-test true",
    markers: ["self-test", "inspect-agent"],
    timeoutMs: 30_000,
  },
  {
    name: "inspect_extensions",
    prompt: "call inspect_extensions --self-test true",
    // "medium" is the English severity label that appears in the data regardless of language.
    markers: ["medium"],
    timeoutMs: 30_000,
  },
  {
    name: "inspect_pathology",
    prompt: "call inspect_pathology --self-test true",
    markers: ["inspect_pathology"],
    timeoutMs: 30_000,
  },
];

// ─── Smoke check: is LM Studio reachable? ─────────────────────────────────────

async function lmStudioReachable(): Promise<boolean> {
  try {
    // Fast 2s timeout so a down LM Studio causes the test to skip quickly.
    const resp = await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Invoke one tool through the real CLI as a synchronous subprocess.
 * Returns exit code + combined stdout/stderr.
 */
function invokeTool(prompt: string, timeoutMs = 120_000): { exitCode: number; stdout: string } {
  const args = [
    CLI,
    "-e", EXT,
    "-p", prompt,
    "--model", MODEL,
    ...(PROVIDER ? ["--provider", PROVIDER] : []),
  ];

  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    timeout: timeoutMs,
  });

  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout).toString(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// L2 tests are OPT-IN (see file header). bun:test has no runtime skip(), so the
// skip decision is made at REGISTRATION time from a one-shot preflight below.
// PI_SKIP_L2=1 (legacy) is honored as a force-skip regardless of PI_RUN_L2.
const l2Enabled = process.env.PI_RUN_L2 === "1" && process.env.PI_SKIP_L2 !== "1";

// PI_REQUIRE_L2=1 turns a blocked L2 test into a hard failure instead of a
// skip — used by run-test.ts's `full` tier so a down LM Studio/vault-mind
// fails the run rather than silently passing via skip.
const requireL2 = process.env.PI_REQUIRE_L2 === "1";

// Preflight once (top-level await is fine under bun:test ESM). When disabled we
// skip the network probe entirely so default `bun test` registers fast.
let lmStudioUp = false;
if (l2Enabled) {
  lmStudioUp = await lmStudioReachable();
}

for (const tool of TOOLS) {
  const blockers: string[] = [];
  if (!l2Enabled) blockers.push("set PI_RUN_L2=1 to run L2 e2e");
  else if (!lmStudioUp) blockers.push("LM Studio not reachable on :1234");
  const { mode, title } = resolveTestMode(tool.name, blockers, l2Enabled, requireL2);
  const runner = mode === "skip" ? test.skip : test;

  runner(title, async () => {
    if (mode === "fail") {
      throw new Error(`${tool.name}: blocked — ${blockers.join("; ")}`);
    }

    const { exitCode, stdout } = invokeTool(tool.prompt, tool.timeoutMs);

    // Gate 1: exit code must be 0
    expect(exitCode, `${tool.name}: exit code 0`).toBe(0);

    // Gate 2: all expected content markers present in stdout (case-insensitive)
    if (tool.markers.length > 0) {
      const lower = stdout.toLowerCase();
      for (const marker of tool.markers) {
        expect(lower, `${tool.name}: stdout contains "${marker}"`).toInclude(marker.toLowerCase());
      }
    }
  }, { timeout: (tool.timeoutMs ?? 120_000) + 5_000 });
}
