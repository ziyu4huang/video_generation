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
 * OPT-IN: L2 tests are SKIPPED by default. They spawn the real pi-agent CLI,
 * load a real model from LM Studio, and (for knowledge_query/graph_health)
 * query the real vault-mind ChromaDB — each takes 30s–10min, far over bun:test's
 * 5s default timeout. Enable explicitly:
 *   PI_RUN_L2=1 bun test bun-apps/pi-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts
 * If a required service is unreachable the test SKIPS with a reason in its title
 * (no spurious 5s-timeout failure). PI_SKIP_L2=1 (legacy) is still honored as a
 * force-skip.
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
 * Is the vault-mind ChromaDB backend (VAULT_MIND_BASE_URL, default :8000) up?
 * Any HTTP response (even 404) counts as "listening" — a wrong path still means
 * the server is there; only a connection refusal/timeout means it's down.
 */
async function vaultMindReachable(): Promise<boolean> {
  const base = process.env.VAULT_MIND_BASE_URL ?? "http://127.0.0.1:8000";
  try {
    await fetch(`${base}/api/v2/heartbeat`, { signal: AbortSignal.timeout(1500) });
    return true;
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

// L2 tests are OPT-IN (see file header). bun:test has no runtime skip(), so the
// skip decision is made at REGISTRATION time from a one-shot preflight below.
// PI_SKIP_L2=1 (legacy) is honored as a force-skip regardless of PI_RUN_L2.
const l2Enabled = process.env.PI_RUN_L2 === "1" && process.env.PI_SKIP_L2 !== "1";

// Preflight once (top-level await is fine under bun:test ESM). When disabled we
// skip the network probes entirely so default `bun test` registers fast.
let lmStudioUp = false;
let vaultMindUp = false;
if (l2Enabled) {
  lmStudioUp = await lmStudioReachable();
  vaultMindUp = await vaultMindReachable();
}

// Tools that query the knowledge graph need the vault-mind ChromaDB service.
const VAULT_TOOLS = new Set(["knowledge_query", "graph_health"]);

for (const tool of TOOLS) {
  const needsVault = VAULT_TOOLS.has(tool.name);
  const blockers: string[] = [];
  if (!l2Enabled) blockers.push("set PI_RUN_L2=1 to run L2 e2e");
  else {
    if (!lmStudioUp) blockers.push("LM Studio not reachable on :1234");
    if (needsVault && !vaultMindUp) blockers.push("vault-mind not reachable on :8000");
  }
  const canRun = blockers.length === 0;
  const runner = canRun ? test : test.skip;
  // Skip reason goes in the title so it's visible in `bun test` output.
  const title = canRun
    ? `L2: ${tool.name}`
    : `L2: ${tool.name} — skipped (${blockers.join("; ")})`;

  runner(title, async () => {
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
