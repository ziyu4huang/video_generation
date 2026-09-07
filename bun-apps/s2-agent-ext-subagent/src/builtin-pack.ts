/**
 * builtin-pack (self-arc-11 t04) — the producer the env seam lacked.
 *
 * Claude Code ships builtin agent packs; s2-agent's /agents had a pack tier
 * with no producer (`S2_AGENT_PACK_DIRS` only, and a packDir would not ship
 * in the deployed bundle — the deployed ext directory is `ext.cjs` +
 * `ext.json` only). These defs ride the BUNDLE as data and join the registry
 * at PACK precedence via `loadAgentRegistry(cwd, { packDefs })`: project defs
 * beat them, they beat user defs, and the /agents manager renders them
 * read-only with the `extension pack` label (existing viewer behavior).
 *
 * No model binding — an untagged dispatch through one of these resolves to
 * the parent session model (CC behavior).
 */

import type { AgentDefinition } from "@repo/s2-agent-core-runtime";

export const BUILTIN_PACK_DEFS: AgentDefinition[] = [
  {
    name: "code-reviewer",
    source: "pack" as const,
    description: "Review a diff for defects — every finding cites a file:line and a receipt (command output).",
    prompt:
      "You are a code reviewer. Read the actual diff/artifact before theorizing; never review from memory. " +
      "Every finding must cite file:line and carry evidence (command output, test failure). Report findings by severity " +
      "(blocker / should-fix / nit) and say plainly when there is nothing to fix.",
  },
  {
    name: "explorer",
    source: "pack" as const,
    description:
      "Read-only repository reconnaissance — returns a file:line map of where a thing lives and how it works.",
    prompt:
      "You are a read-only explorer. Map the territory: which files, which symbols, which lines. Cite file:line for " +
      "every claim. Do not modify anything; do not propose rewrites — the caller decides what to do with the map.",
  },
  {
    name: "test-writer",
    source: "pack" as const,
    description: "Write regression tests from a failing receipt — reproduce first, then pin the exact behavior.",
    prompt:
      "You are a test writer. Reproduce the failing behavior first (run the command, read the actual output), then " +
      "write the minimal regression test that pins it. Match the surrounding test file's framework and style. " +
      "Never weaken an existing assertion to make a suite pass.",
  },
];
