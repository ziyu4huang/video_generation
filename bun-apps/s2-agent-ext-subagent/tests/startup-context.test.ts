/**
 * Startup-context block — cc-parity-2 ticket 04
 * (effort .planning/2026-08-23-subagent-cc-parity-2, map D5).
 *
 * Three layers:
 *  1. the pure composer (buildStartupContextBlock): ordering, mode dial
 *     (full/minimal/none), caps (roster rows, porcelain lines, hard char cap);
 *  2. the roster builder (buildSiblingRoster): named-first ordering + cap;
 *  3. the MEASUREMENT that gates the whole ticket (Approach step 1): a real
 *     spawnSubagent child over a faux transport, pinned on what its system
 *     prompt ALREADY contains — the CLAUDE.md hierarchy via pi's resource
 *     loader, walked per spawn cwd. Ticket 04 builds a PREFIX block on top of
 *     that inheritance; this test is what proves the inheritance exists, so a
 *     future pi upgrade that drops it fails HERE instead of silently double-
 *     carrying (or losing) repo context.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  __resetLiveAgentRegistryForTests,
  LiveAgentRegistry,
  SubagentInFlightRegistry,
  spawnSubagent,
} from "@repo/s2-agent-core-runtime";
import { realGitSnapshotOps } from "../src/git-scope.js";
import {
  buildSiblingRoster,
  buildStartupContextBlock,
  DEFAULT_BATCH_STARTUP_CAP_CHARS,
  DEFAULT_STARTUP_CAP_CHARS,
  MAX_ROSTER_ROWS,
  type RosterRow,
  STARTUP_CONTEXT_HEADER,
} from "../src/startup-context.js";

const SNAP = {
  branch: "## feature-x...origin/feature-x",
  head: "a1b2c3d ticket 04: startup context",
  statusLines: ["M bun-apps/s2-agent-ext-subagent/src/subagent-tool.ts", "?? scratch.txt"],
};

const ROSTER: RosterRow[] = [
  { name: "researcher", status: "idle", role: "agentType explore" },
  { name: "run-1", status: "running", role: "one-shot: grep the seams" },
];

describe("buildStartupContextBlock — modes", () => {
  test("full: header + git section (branch/HEAD/porcelain) + sibling roster", () => {
    const block = buildStartupContextBlock({ spawnCwd: "/repo", gitStatus: SNAP, roster: ROSTER, mode: "full" });
    expect(block).toBeDefined();
    const body = block as string;
    expect(body.startsWith(STARTUP_CONTEXT_HEADER)).toBe(true);
    expect(body).toContain("### Git (snapshot at spawn)");
    expect(body).toContain(SNAP.branch);
    expect(body).toContain(`HEAD: ${SNAP.head}`);
    expect(body).toContain(SNAP.statusLines[0]);
    expect(body).toContain("### Siblings");
    expect(body).toContain("- researcher [idle] — agentType explore");
    // Git BEFORE roster — location context first, actors second.
    expect(body.indexOf("### Git")).toBeLessThan(body.indexOf("### Siblings"));
    expect(body).toContain("(/repo)");
  });

  test("minimal: branch + HEAD only — no porcelain body, no roster", () => {
    const block = buildStartupContextBlock({ spawnCwd: "/repo", gitStatus: SNAP, roster: ROSTER, mode: "minimal" });
    expect(block).toBeDefined();
    expect(block).toContain(SNAP.branch);
    expect(block).toContain(`HEAD: ${SNAP.head}`);
    expect(block).not.toContain(SNAP.statusLines[0]);
    expect(block).not.toContain("### Siblings");
  });

  test("none: no block, ever", () => {
    expect(
      buildStartupContextBlock({ spawnCwd: "/repo", gitStatus: SNAP, roster: ROSTER, mode: "none" }),
    ).toBeUndefined();
  });

  test("empty inputs → undefined (no noise block; non-repo dispatch keeps the spawned task identical)", () => {
    expect(buildStartupContextBlock({ spawnCwd: "/tmp", mode: "full" })).toBeUndefined();
    expect(
      buildStartupContextBlock({ spawnCwd: "/tmp", gitStatus: { statusLines: [] }, mode: "full" }),
    ).toBeUndefined();
    expect(buildStartupContextBlock({ spawnCwd: "/tmp", roster: [], mode: "full" })).toBeUndefined();
  });

  test("roster-only block renders when git is absent (non-repo cwd with live siblings)", () => {
    const block = buildStartupContextBlock({ spawnCwd: "/tmp", roster: ROSTER, mode: "full" });
    expect(block).toBeDefined();
    expect(block).toContain("### Siblings");
    expect(block).not.toContain("### Git");
  });
});

describe("buildStartupContextBlock — caps", () => {
  test("porcelain body truncates past 20 lines with a named marker", () => {
    const statusLines = Array.from({ length: 30 }, (_, i) => `M  file-${i}.ts`);
    const block = buildStartupContextBlock({ spawnCwd: "/repo", gitStatus: { ...SNAP, statusLines }, mode: "full" });
    expect(block).not.toContain("file-25.ts");
    expect(block).toContain("[... 10 more entries truncated ...]");
  });

  test("capChars is a hard bound", () => {
    const statusLines = Array.from({ length: 40 }, (_, i) => `M  dir-${i}/some/fairly/long/path/file-${i}.ts`);
    const block = buildStartupContextBlock({
      spawnCwd: "/repo",
      gitStatus: { ...SNAP, statusLines },
      mode: "full",
      capChars: 300,
    });
    expect((block as string).length).toBeLessThanOrEqual(300 + STARTUP_CONTEXT_HEADER.length + 1);
  });

  test("default caps: singular 2000, batch tighter 1000", () => {
    expect(DEFAULT_STARTUP_CAP_CHARS).toBe(2000);
    expect(DEFAULT_BATCH_STARTUP_CAP_CHARS).toBe(1000);
  });
});

describe("buildSiblingRoster", () => {
  test("named live agents first, then non-terminal one-shots, capped at MAX_ROSTER_ROWS", () => {
    __resetLiveAgentRegistryForTests();
    const live = new LiveAgentRegistry(6);
    for (let i = 0; i < 3; i++) {
      const res = live.register({
        name: `agent-${i}`,
        agentId: `id-${i}`,
        agent: { status: "idle", send: async () => ({ output: "" }), touch() {}, dispose() {} },
        cwd: "/repo",
        ...(i === 1 ? { agentType: "explore" } : {}),
      });
      expect(res).not.toHaveProperty("error");
    }
    const inFlight = new SubagentInFlightRegistry();
    inFlight.start({ id: "run-x", taskPreview: "grep the seams", workIntent: "grep the seams" });
    inFlight.start({ id: "run-done", taskPreview: "finished" });
    inFlight.markCompleted("run-done");

    const rows = buildSiblingRoster(live, inFlight);
    expect(rows.length).toBe(4);
    expect(rows[0]).toEqual({ name: "agent-0", status: "idle", role: "named agent" });
    expect(rows[1]).toEqual({ name: "agent-1", status: "idle", role: "agentType explore" });
    expect(rows[2]).toEqual({ name: "agent-2", status: "idle", role: "named agent" });
    expect(rows[3]).toMatchObject({ name: "run-x", status: "running", role: "one-shot: grep the seams" });

    // Cap: 20 live agents → exactly MAX_ROSTER_ROWS rows, in registration order.
    const big = new LiveAgentRegistry(32);
    for (let i = 0; i < 20; i++) {
      const res = big.register({
        name: `a${i}`,
        agentId: `aid${i}`,
        agent: { status: "idle", send: async () => ({ output: "" }), touch() {}, dispose() {} },
        cwd: "/repo",
      });
      expect(res).not.toHaveProperty("error");
    }
    expect(buildSiblingRoster(big).length).toBe(MAX_ROSTER_ROWS);
    expect(buildSiblingRoster(big)[0].name).toBe("a0");
  });

  test("undefined registries → empty roster", () => {
    expect(buildSiblingRoster()).toEqual([]);
  });
});

describe("realGitSnapshotOps", () => {
  test("parses branch/head/status from a real temp repo; non-repo → undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-startup-git-"));
    try {
      execFileSync("git", ["-C", dir, "init", "-q"]);
      execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
      execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
      writeFileSync(join(dir, "a.txt"), "a");
      execFileSync("git", ["-C", dir, "add", "a.txt"]);
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
      writeFileSync(join(dir, "b.txt"), "b");

      const snap = realGitSnapshotOps.snapshot(dir);
      expect(snap).resolves.toMatchObject({
        branch: expect.stringContaining("##") as string,
        head: expect.stringContaining("init") as string,
        statusLines: ["?? b.txt"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const bare = mkdtempSync(join(tmpdir(), "s2-startup-nogit-"));
    try {
      expect(realGitSnapshotOps.snapshot(bare)).resolves.toBeUndefined();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ── MEASUREMENT (Approach step 1): what a spawned child's system prompt ──────
// already contains. Real spawnSubagent → CoreAgent.assembleSession →
// createAgentSession({cwd}) over the pi faux provider (zero network), capturing
// the request context via a faux response FACTORY. Pins the resource-loader
// inheritance claim the whole ticket builds on (map S3), including the
// ancestor-walk (a child spawned in a NESTED dir inherits the parent dir's
// CLAUDE.md too).

describe("measurement: child system prompt inherits the CLAUDE.md hierarchy", () => {
  test("CLAUDE.md at the spawn cwd (and at an ancestor) appears in the child's system prompt", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "s2-startup-agentdir-"));
    const repoDir = mkdtempSync(join(tmpdir(), "s2-startup-cwd-"));
    const nestedDir = join(repoDir, "pkg", "deep");
    mkdirSync(nestedDir, { recursive: true });
    const rootSentinel = "S2-STARTUP-CONTEXT-ROOT-SENTINEL-4f2a";
    const nestedSentinel = "S2-STARTUP-CONTEXT-NESTED-SENTINEL-91cd";
    writeFileSync(join(repoDir, "CLAUDE.md"), `# Repo guide\n\n${rootSentinel}\n`);
    writeFileSync(join(nestedDir, "CLAUDE.md"), `# Nested guide\n\n${nestedSentinel}\n`);

    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const core = createFauxCore({
        provider: "startup-ctx",
        models: [{ id: "faux-startup", name: "Faux Startup", contextWindow: 128_000, maxTokens: 4096 }],
      });
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerProvider("startup-ctx", {
        api: core.api as never,
        apiKey: "faux-not-used",
        streamSimple: core.streamSimple as never,
        models: core.models as never,
      });

      const captured: Array<{ systemPrompt?: string }> = [];
      const capture = (_ctx: unknown) => {
        captured.push(_ctx as { systemPrompt?: string });
        return fauxAssistantMessage("ok", { stopReason: "stop" });
      };
      core.setResponses([capture, capture] as never);

      const session = { model: core.getModel() as never, modelRuntime } as never;

      // Child at the REPO root: sees the root CLAUDE.md.
      await spawnSubagent({
        task: "report",
        cwd: repoDir,
        session,
        maxTurns: 1,
        timeoutMs: 30_000,
      });
      // Child at the NESTED dir: sees BOTH its own and the ancestor's CLAUDE.md
      // (the ancestor-walk is the whole reason we do NOT re-inject repo context
      // in the startup block).
      await spawnSubagent({
        task: "report",
        cwd: nestedDir,
        session,
        maxTurns: 1,
        timeoutMs: 30_000,
      });

      expect(captured.length).toBe(2);
      const [rootPrompt, nestedPrompt] = captured.map((c) => c.systemPrompt ?? "");
      expect(rootPrompt).toContain(rootSentinel);
      expect(nestedPrompt).toContain(nestedSentinel);
      expect(nestedPrompt).toContain(rootSentinel);
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 60_000);
});
