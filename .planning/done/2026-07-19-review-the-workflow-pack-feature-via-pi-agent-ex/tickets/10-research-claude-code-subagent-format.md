## Question

What is **Claude Code's subagent definition format** (`.claude/agents/*.md` frontmatter schema: name, description, tools, model, role prompt), and is there precedent for a **self-contained subagent bundle** portable across harnesses? What does Claude Code's "dynamic workflows" model look like, for compatibility mapping?

type: research
status: closed
claimed: chart-session (2026-07-19)

blocked by: _(none — was frontier; resolved by the chart-session research pass)_

## Context

This effort must produce "subagent definition compatible with claude-code" (user requirement). 09 (bundled subagent defs) is blocked on knowing the exact `.claude/agents` schema so the pack's `agents/*.md` are genuinely cross-harness. Research the official Claude Code agents format, its frontmatter fields + semantics, and whether a single frontmatter dialect is consumable by both Claude Code and Pi (Pi's `.pi/agents` already "mirrors" it per `agent-registry.ts` — confirm the mirror is exact or document the delta). Capture findings as the ticket resolution.

## Resolution — findings

Both are **Markdown + YAML frontmatter, body = prompt**, stored in a per-scope dir (CC: `.claude/agents/` + `~/.claude/agents/`; Pi: `.pi/agents/` + `~/.pi/agents/`). The mirror is **~90% exact** — the common spine is identical:

| field | Claude Code `.claude/agents` | Pi `.pi/agents` (`agent-registry.ts`) |
|---|---|---|
| `name` | required, kebab-case | frontmatter `name` else filename |
| `description` | required (drives auto-delegation) | optional (discoverability) |
| `tools` | **comma-separated string** (`tools: Write, Edit, Bash`) | **YAML array** (`tools: [Write, Edit]`) — `toStringArray` returns `undefined` for a non-array |
| `model` | string or literal `"inherit"` | string spec (`provider/id`) |
| body | system prompt | role prompt (prepended to task) |

**The one hard interop trap — `tools` serialization.** A CC-style `tools: Write, Edit` (string) is silently parsed by Pi as **no allowlist → all tools** (security/semantic divergence). A Pi-style `tools: [Write, Edit]` (YAML array) may or may not be accepted by CC (unconfirmed). **Ticket 09 must pick**: (a) one canonical form both parse (confirm whether YAML flow-seq works in CC), (b) ship dual files (`.claude/agents/` + `.pi/agents/`), or (c) a normalizer in the pack resolver.

**Pi-only extensions** (ignored by CC, degraded-but-not-broken semantics): `disallowedTools` (denylist), `isolation: "worktree"`, plus parsed-but-ignored `mcp`/`skills`/`background`. CC has its own equivalents (different field names) — not portable.

**No precedent found** for a self-contained *subagent bundle* portable across harnesses; the pack-level bundling this effort adds would be novel. Skills (separate open standard) are out of scope here.

Sources: code.claude.com/docs/en/sub-agents, code.claude.com/docs/en/agent-sdk/subagents.md, thepromptshelf.dev/blog/claude-code-subagents-complete-reference-2026.
