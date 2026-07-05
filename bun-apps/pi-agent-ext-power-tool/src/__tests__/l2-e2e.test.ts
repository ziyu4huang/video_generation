/**
 * l2-e2e.test.ts — L2 regression e2e for pi-agent-ext-power-tool.
 *
 * WHAT THIS TESTS (vs the L0/L1 power-tool unit test):
 *   L0 — unit tests: mock ExtensionAPI, call execute() directly.
 *   L1 — this file: spawn the REAL pi-agent CLI as a subprocess, load the
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
 *   - LM Studio running on localhost:1234 with google/gemma-4-26b-a4b-qat
 *     loaded (or a different model configured via PI_L2_MODEL)
 *   - pi-agent dependencies installed (bun install at repo root)
 *   - Model inference per tool: ~5-15s (warming) + ~2-5s (steady)
 *
 * RUN (from repo root):
 *   bun test bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts
 *
 * RUN all power-tool tests:
 *   ( cd bun-apps/pi-agent-ext-power-tool && bun test )
 *
 * SKIP if LM Studio is unavailable:
 *   PI_SKIP_L2=1 bun test ...
 */

import { test, expect } from "bun:test";
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
const CLI = `${REPO_ROOT}/bun-apps/pi-agent/src/cli.ts`;
const EXT = `${REPO_ROOT}/bun-apps/pi-agent-ext-power-tool/src/index.ts`;
const MODEL = process.env.PI_L2_MODEL || "google/gemma-4-26b-a4b-qat";

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
    name: "context_analyzer",
    prompt: "call context_analyzer --self-test true",
    // Tool name in backticks survives LLM translation reliably.
    markers: ["context_analyzer"],
    // Self-test mode: still needs model inference for prompt→tool routing,
    // but returns immediately once the tool is invoked. Short timeout so a
    // non-responsive model fails fast rather than hanging.
    timeoutMs: 30_000,
  },
  {
    name: "agent_inventory",
    prompt: "call agent_inventory --self-test true",
    markers: ["self-test", "agent_inventory"],
    timeoutMs: 30_000,
  },
  {
    name: "extension_analyzer",
    prompt: "call extension_analyzer --self-test true",
    // "medium" is the English severity label that appears in the data regardless of language.
    markers: ["medium"],
    timeoutMs: 30_000,
  },
  {
    name: "knowledge_query",
    prompt: "call knowledge_query --query test --topK 1",
    markers: [], // content-agnostic: even "no results" is valid; exit 0 is the gate
    timeoutMs: 300_000, // vault query can be slow
  },
  {
    name: "graph_health",
    prompt: "call graph_health",
    markers: [], // content-agnostic: LLM output language varies (zh-TW/en); exit 0 is the gate
    timeoutMs: 600_000, // vault scan + VLM inference can take 3-8 min
  },
  {
    name: "todo",
    prompt: "call todo --action list",
    // Tool name is translated in zh-TW output; exit 0 + no error is the gate.
    markers: [],
  },
  {
    name: "ask_user_question",
    prompt: `call ask_user_question --questions '[{"question":"test","header":"Test","options":[{"label":"a","description":"opt a"},{"label":"b","description":"opt b"}]}]'`,
    markers: ["ask_user_question"],
  },
  {
    name: "goal_complete",
    prompt: "call goal_complete --summary 'test'",
    // "goal" appears in `/goal` in both zh-TW and en output.
    markers: ["goal"],
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

const shouldSkip = process.env.PI_SKIP_L2 === "1";
const L2 = shouldSkip ? test.skip : test;

for (const tool of TOOLS) {
  // Use test.skip (static modifier) when PI_SKIP_L2=1; the reachable check
  // below fails fast with a clear message rather than timing out silently.
  L2(`L2: ${tool.name}`, async () => {
    // Fail-fast preflight: without LM Studio the CLI invocation will hang.
    // We use lmStudioReachable() with a short timeout to avoid the previous
    // silent 5000ms+ timeout behavior.
    const reachable = await lmStudioReachable();
    if (!reachable) {
      throw new Error(
        "LM Studio not reachable on localhost:1234 — cannot run L2 test. " +
        "Start LM Studio or set PI_SKIP_L2=1 to skip.",
      );
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
  });
}
