/**
 * Built-in agent types (cc-parity-2 ticket 03) — Claude Code's Explore/Plan-style
 * read-only agents, shippable with zero user setup.
 *
 * Doctrine (map D4): built-ins are the LOWEST-precedence tier (project > pack >
 * user > builtin). A user file with the same name shadows the built-in
 * COMPLETELY (no field merging) — "definitions are user files" stays true.
 * They ship as code (`source: "builtin"`), are never written to disk, and are
 * folded into `loadAgentRegistry` only after the directory scans miss.
 *
 * Read-only-ness: the `tools` allowlist is exactly pi's `createReadOnlyTools`
 * set (read/grep/find/ls — measured in pi 0.84.2 dist/core/tools/index.js), so
 * an `explore`/`plan` child cannot edit/write/bash even before the denylist.
 * The explicit `disallowedTools` mirrors READ_ONLY_EXCLUDED
 * (s2-agent-ext-subagent subagents-tool.ts) — belt-and-braces so the def stays
 * inside the batch tool's non-overridable read-only notion even if the
 * allowlist is ever loosened.
 */

import type { AgentDefinition } from "./agent-registry.js";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const READ_ONLY_DENIED = ["edit", "write", "bash"];

export const BUILTIN_AGENT_DEFS: AgentDefinition[] = [
  {
    name: "explore",
    description:
      "Read-only codebase exploration: locate code, answer where/is-there questions, return file:line evidence.",
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [...READ_ONLY_DENIED],
    prompt: [
      "You are a read-only exploration agent. Your job is to LOCATE and REPORT, never to modify anything.",
      "",
      "Rules:",
      "- Search broadly first (find/grep), then read only the files that matter.",
      "- Cite every conclusion as file:line so the caller can jump straight there.",
      "- You have no edit/write/bash: do not attempt changes, and do not ask for them.",
      "- Return a concise summary: the answer first, then the evidence list. If nothing is found, say so plainly.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "plan",
    description:
      "Read-only planning: analyze the codebase and produce an implementation plan with files, steps, and risks.",
    tools: [...READ_ONLY_TOOLS],
    disallowedTools: [...READ_ONLY_DENIED],
    prompt: [
      "You are a read-only planning agent. Read the relevant code, then produce an implementation plan.",
      "",
      "Rules:",
      "- Ground every step in code you actually read; cite file:line for current behavior.",
      "- Output: goal, approach, ordered steps, files to touch, risks/edge cases, and how to verify.",
      "- You have no edit/write/bash: planning only — implementation happens in the caller's session.",
      "- Keep the plan self-contained; the caller will not see your reading history.",
    ].join("\n"),
    source: "builtin",
  },
];
