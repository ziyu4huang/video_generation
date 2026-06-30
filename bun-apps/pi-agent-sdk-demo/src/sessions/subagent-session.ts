/**
 * Session builder: subagent-enabled session.
 *
 * The parent agent is a pure orchestrator — its ONLY tool is `subagent`.
 * It cannot read files or run bash itself; all real work is delegated to
 * specialized agents (defined in .pi/agents/*.md). Each subagent spawns THIS
 * app's own CLI in an isolated JSON-mode session.
 *
 * Modes available via the subagent tool:
 *   single   { agent, task }
 *   parallel { tasks: [{agent, task}, ...] }   ← runs all at once
 *   chain    { chain: [{agent, task}, ...] }   ← each step feeds {previous}
 */
import { createSharedSession } from "./shared.ts";
import { createSubagentTool } from "../subagent-tool.ts";

const ORCHESTRATOR_INSTRUCTIONS = `
## Orchestrator rules
You are a pure orchestrator. Your ONLY tool is \`subagent\` — you cannot run bash, read files, or use any other tool.
You MUST delegate ALL real work to subagents. Never answer from memory.

### subagent tool modes

Parallel — run multiple tasks simultaneously (single tool call):
  { "tasks": [{ "agent": "scout", "task": "list .md files" }, { "agent": "scout", "task": "list .ts files" }] }

Chain — sequential steps, each receiving the previous output via {previous}:
  { "chain": [{ "agent": "scout", "task": "find files" }, { "agent": "worker", "task": "summarize: {previous}" }] }

Single — one task:
  { "agent": "scout", "task": "describe the project structure" }

### Report format
Return the subagent result verbatim, including the model label in each section header.
`;

export async function buildSubagentSession() {
  const subagentTool = createSubagentTool();
  return createSharedSession({
    tools: ["subagent"],
    customTools: [subagentTool],
    extensionFactories: [
      (pi: any) => {
        pi.on("before_agent_start", (event: any) => ({
          systemPrompt: event.systemPrompt + ORCHESTRATOR_INSTRUCTIONS,
        }));
      },
    ],
  });
}
