/**
 * Subagent tool — delegates tasks to specialized agents by spawning THIS app's
 * own CLI in isolated JSON-mode sessions.
 *
 * Now that `chat` understands pi-aligned flags (--mode json, --no-session,
 * --tools, --append-system-prompt), this tool is minimal:
 *
 *   bun src/cli.ts chat --mode json --no-session \
 *     --tools read,grep,find \
 *     --append-system-prompt <tmp-file> \
 *     "<task>"
 *
 * Output is parsed as NDJSON; we extract the final assistant message from
 * `message_end` / `agent_end` events (no fragile stdout filtering).
 *
 * Agent definitions live in:
 *   ~/.pi/agent/agents/*.md   (user-level)
 *   .pi/agents/*.md           (project-level, overrides user)
 *
 * Markdown frontmatter: name, description, tools, model, + body = system prompt.
 *
 * Modes (mirrors pi):
 *   single   { agent, task }
 *   parallel { tasks: [{ agent, task }, ...] }
 *   chain    { chain: [{ agent, task: "... {previous} ..." }, ...] }
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import { defineTool, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// ---------- agent discovery ----------

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!existsSync(dir)) return [];
  const agents: AgentConfig[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = join(dir, entry.name);
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
      readFileSync(filePath, "utf-8"),
    );
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools?.length ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

/**
 * Find the project root that contains `.pi/agents/`.
 *
 * Strategy (first match wins):
 *   1. Walk up from `start` — handles source mode (script inside project)
 *   2. Sibling lookup — handles bundled mode where script is in dist/<app>/cli.js
 *      but agents live in <parent>/<app>/.pi/agents/
 */
function findProjectRootWithAgents(scriptPath: string): string | null {
  // Walk-up scan
  let dir = dirname(scriptPath);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".pi", "agents"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Sibling lookup: dist/<app-name>/cli.js → <grandparent>/<app-name>/.pi/agents
  const scriptDir = dirname(scriptPath);              // dist/bun-pi-agent-sdk-demo
  const appName   = basename(scriptDir);              // bun-pi-agent-sdk-demo
  const distDir   = dirname(scriptDir);               // dist
  const parentDir = dirname(distDir);                 // pi-agent
  const sibling   = join(parentDir, appName);         // pi-agent/bun-pi-agent-sdk-demo
  if (existsSync(join(sibling, ".pi", "agents"))) return sibling;

  return null;
}

/** Discover agents from user dir (~/.pi/agent/agents) + project dir (.pi/agents).
 *
 * Project dir resolution order (first match wins):
 *   1. <cwd>/.pi/agents            — standard: run from project root
 *   2. Walk up / sibling of script — bundled CLI invoked from another directory
 */
export function discoverAgents(cwd: string): AgentConfig[] {
  const userDir = join(getAgentDir(), "agents");

  let projectRoot = existsSync(join(cwd, ".pi", "agents")) ? cwd : null;
  if (!projectRoot) {
    projectRoot = findProjectRootWithAgents(process.argv[1] ?? "");
  }

  const map = new Map<string, AgentConfig>();
  for (const a of loadAgentsFromDir(userDir, "user")) map.set(a.name, a);
  if (projectRoot) {
    for (const a of loadAgentsFromDir(join(projectRoot, ".pi", "agents"), "project")) {
      map.set(a.name, a);
    }
  }
  return [...map.values()];
}

// ---------- subprocess spawning ----------

/** Decide how to invoke THIS app's CLI. */
function getCliInvocation(extraArgs: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return { command: process.execPath, args: [script, ...extraArgs] };
  }
  // Compiled/bundled: fall back to the bundle next to cwd.
  return { command: process.execPath, args: [script ?? "src/cli.ts", ...extraArgs] };
}

interface SubResult {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  step?: number;
  model?: { provider: string; id: string; name?: string };
}

/**
 * Spawn one subagent via `chat --mode json --no-session`.
 * Returns the final assistant text, extracted from NDJSON events.
 */
async function runOneAgent(
  cwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  step?: number,
): Promise<SubResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      task,
      exitCode: 1,
      output: `Unknown agent "${agentName}". Available: ${available}.`,
      stderr: "",
      step,
    };
  }

  // Build CLI args — all pi-aligned flags.
  const cliArgs = ["chat", "--mode", "json", "--no-session"];
  if (agent.tools?.length) {
    cliArgs.push("--tools", agent.tools.join(","));
  }

  // System prompt → temp file → --append-system-prompt.
  let tmpDir: string | null = null;
  if (agent.systemPrompt.trim()) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
    const promptFile = join(tmpDir, "system.md");
    writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
    cliArgs.push("--append-system-prompt", promptFile);
  }

  // Model override via env (chat already reads PI_MODEL).
  const env: Record<string, string> = { ...process.env };
  if (agent.model) env.PI_MODEL = agent.model;

  cliArgs.push(task);

  try {
    const inv = getCliInvocation(cliArgs);
    const { exitCode, stdout, stderr } = await new Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const proc = spawn(inv.command, inv.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
      proc.on("error", () => resolve({ exitCode: 1, stdout, stderr }));
    });

    const parsed = extractSubagentOutput(stdout);
    return {
      agent: agentName,
      task,
      exitCode,
      output: parsed.text,
      stderr,
      step,
      model: parsed.model,
    };
  } finally {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

interface ParsedSubagentOutput {
  text: string;
  model?: { provider: string; id: string; name?: string };
}

/**
 * Parse NDJSON output and extract the final assistant message text + model info.
 * Looks for `message_end` events with role "assistant" (takes the last one)
 * and a `model` event emitted by the JSON-mode session header.
 */
export function extractSubagentOutput(stdout: string): ParsedSubagentOutput {
  let lastAssistantText = "";
  let model: ParsedSubagentOutput["model"];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "model" && event.provider) {
      model = { provider: event.provider, id: event.id, name: event.name };
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content as any[])
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("") ?? "";
      if (text.trim()) lastAssistantText = text;
    }
  }
  return { text: lastAssistantText, model };
}

/** @deprecated Use extractSubagentOutput */
export function extractFinalAssistantText(stdout: string): string {
  return extractSubagentOutput(stdout).text;
}

// ---------- the tool ----------

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate" }),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task; use {previous} for prior step's output" }),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential chain" })),
});

/** Build the subagent tool, bound to a working directory (for agent discovery). */
export function createSubagentTool(cwd: string = process.cwd()) {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to specialized subagents (defined in .pi/agents/*.md or " +
      "~/.pi/agent/agents/*.md). Each runs in an isolated JSON-mode session of " +
      "THIS app's CLI. Modes: single {agent,task}, parallel {tasks:[]}, chain {chain:[]}.",
    parameters: SubagentParams,
    async execute(_id, params) {
      const agents = discoverAgents(cwd);

      // chain mode
      if (params.chain?.length) {
        const results: SubResult[] = [];
        let previous = "";
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const task = step.task.replace(/\{previous\}/g, previous);
          const r = await runOneAgent(cwd, agents, step.agent, task, i + 1);
          results.push(r);
          if (r.exitCode !== 0) {
            return {
              content: [{ type: "text" as const, text: `Chain failed at step ${i + 1} (${step.agent}): ${r.output}` }],
              details: { mode: "chain", results },
              isError: true,
            };
          }
          previous = r.output;
        }
        const chainSummary = results
          .map((r) => {
            const modelLabel = r.model
              ? ` (${r.model.name ?? `${r.model.provider}/${r.model.id}`})`
              : "";
            return `### Step ${r.step} [${r.agent}]${modelLabel}\n\n${r.output}`;
          })
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text" as const, text: chainSummary }],
          details: { mode: "chain", results },
        };
      }

      // parallel mode
      if (params.tasks?.length) {
        const results = await Promise.all(
          params.tasks.map((t) => runOneAgent(cwd, agents, t.agent, t.task)),
        );
        const summary = results
          .map((r) => {
            const modelLabel = r.model
              ? ` (${r.model.name ?? `${r.model.provider}/${r.model.id}`})`
              : "";
            const status = r.exitCode === 0 ? "completed" : "failed";
            return `### [${r.agent}]${modelLabel} ${status}\n\n${r.output}`;
          })
          .join("\n\n---\n\n");
        return {
          content: [{ type: "text" as const, text: summary }],
          details: { mode: "parallel", results },
        };
      }

      // single mode
      if (params.agent && params.task) {
        const r = await runOneAgent(cwd, agents, params.agent, params.task);
        const modelLabel = r.model
          ? `\n[model: ${r.model.name ?? `${r.model.provider}/${r.model.id}`}]`
          : "";
        const text = r.output ? `${r.output}${modelLabel}` : `(no output)${modelLabel}`;
        return {
          content: [{ type: "text" as const, text }],
          details: { mode: "single", results: [r] },
          isError: r.exitCode !== 0,
        };
      }

      const available = agents.map((a) => `${a.name} — ${a.description}`).join("\n") || "none";
      return {
        content: [{ type: "text" as const, text: `Provide exactly one mode. Available agents:\n${available}` }],
        details: { mode: "single", results: [] },
      };
    },
  });
}
