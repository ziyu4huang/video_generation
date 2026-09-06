/**
 * Named workflow subagent definitions ("agentType" registry).
 *
 * A workflow script can route an agent() call to a reusable, named definition:
 *
 *   agent("audit this dir", { agentType: "security-auditor" })
 *
 * Definitions live as Markdown files under `.pi/agents/*.md` (project, cwd-relative)
 * and `~/.pi/agents/*.md` (user). Frontmatter binds the subagent's tools, model,
 * and a body prompt; project definitions win on a name collision. This mirrors
 * Claude Code's `.claude/agents` registry: agentType is a real binding of
 * tools+model+system-prompt, not a prose hint.
 *
 * Bound today: `tools` (allowlist), `disallowedTools` (denylist), `model`,
 * and the markdown body (`prompt`). Parsed-but-ignored for now (documented): `mcp`, `skills`, `background`.
 * Wired: `isolation` ("worktree") → createWorktree() in workflow.ts.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENT_DEFS } from "./builtin-agents.js";
import { AGENTS_DIR } from "./config.js";
import { homeDir } from "./home.js";

export interface AgentDefinition {
  /** Stable identity used as the `agentType` value. */
  name: string;
  /** One-line summary (for discoverability in the tool guideline). */
  description?: string;
  /** Allowlist of coding-tool names the subagent may use. Undefined = all. */
  tools?: string[];
  /** Denylist of coding-tool names, applied after the allowlist. */
  disallowedTools?: string[];
  /** Model spec (`provider/modelId` or bare id) for this subagent. */
  model?: string;
  /** Model tier name (e.g. "small"/"medium"/"big") resolved from model-tiers config. */
  tier?: string;
  /** Isolation mode. When "worktree", agents using this type run in a git worktree. */
  isolation?: "worktree";
  /** Markdown body, prepended to the subagent's task as role guidance. */
  prompt: string;
  /** Where the definition was loaded from. Precedence: project > pack > user > builtin. */
  source: "project" | "pack" | "user" | "builtin";
}

export type AgentRegistry = Map<string, AgentDefinition>;

function toStringArray(value: unknown): string[] | undefined {
  // Accept a YAML array OR a Claude-Code-style comma-separated string (ticket 14 /
  // decision 09). A string is split on commas + trimmed; empty entries dropped.
  // This fixes the silent "no allowlist = all tools" trap: a CC string was parsed
  // as undefined → no allowlist → ALL tools (the opposite of intended).
  if (typeof value === "string") {
    const arr = value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return arr.length ? arr : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return arr.length ? arr : undefined;
}

/**
 * Parse one agent-definition markdown file. Returns null only when there is no
 * usable content (no name derivable and an empty body).
 */
export function parseAgentDefinition(
  content: string,
  source: "project" | "pack" | "user",
  fileName: string,
): AgentDefinition | null {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content);
  } catch {
    // Malformed frontmatter: treat the whole file as a body, name from filename.
    parsed = { frontmatter: {}, body: content };
  }
  const fm = parsed.frontmatter;
  const fmName = typeof fm.name === "string" ? fm.name.trim() : "";
  const name = fmName || basename(fileName).replace(/\.md$/i, "").trim();
  const prompt = parsed.body.trim();
  if (!name && !prompt) return null;

  return {
    name,
    description: typeof fm.description === "string" ? fm.description.trim() || undefined : undefined,
    tools: toStringArray(fm.tools),
    disallowedTools: toStringArray(fm.disallowedTools),
    model: typeof fm.model === "string" ? fm.model.trim() || undefined : undefined,
    tier: typeof fm.tier === "string" ? fm.tier.trim() || undefined : undefined,
    isolation:
      typeof fm.isolation === "string" && fm.isolation.toLowerCase().trim() === "worktree" ? "worktree" : undefined,
    prompt,
    source,
  };
}

function readDefsFromDir(dir: string, source: "project" | "pack" | "user"): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  } catch {
    return [];
  }
  const defs: AgentDefinition[] = [];
  for (const file of files.sort()) {
    try {
      const def = parseAgentDefinition(readFileSync(join(dir, file), "utf-8"), source, file);
      if (def) defs.push(def);
    } catch {
      // Skip unreadable/invalid files; never let one bad file break the registry.
    }
  }
  return defs;
}

/**
 * Load the agent registry once for a run. Scans the project dir then the user
 * dir; the FIRST definition for a name wins (project > user, then filename
 * order), so a name collision is resolved deterministically and silently.
 * Built-in types (ticket 03) fill only the names the scans missed.
 *
 * `opts` overrides the scanned directories (used by tests).
 */
export function loadAgentRegistry(
  cwd: string,
  opts?: { projectDir?: string; userDir?: string; packDirs?: string[] },
): AgentRegistry {
  const projectDir = opts?.projectDir ?? join(cwd, AGENTS_DIR);
  const userDir = opts?.userDir ?? join(homeDir(), AGENTS_DIR);
  const packDirs = opts?.packDirs ?? [];
  const registry: AgentRegistry = new Map();
  for (const def of readDefsFromDir(projectDir, "project")) {
    if (def.name && !registry.has(def.name)) registry.set(def.name, def);
  }
  for (const dir of packDirs) {
    for (const def of readDefsFromDir(dir, "pack")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  if (userDir !== projectDir && !packDirs.includes(userDir)) {
    for (const def of readDefsFromDir(userDir, "user")) {
      if (def.name && !registry.has(def.name)) registry.set(def.name, def);
    }
  }
  // Built-ins are the LOWEST-precedence tier (ticket 03, map D4): they fill a
  // name only when no directory scan defined it — a user/project file with the
  // same name shadows the built-in COMPLETELY (first-wins above, no merge).
  for (const def of BUILTIN_AGENT_DEFS) {
    if (!registry.has(def.name)) registry.set(def.name, def);
  }
  return registry;
}

/** Resolve an agentType name to its definition, or undefined if not registered. */
export function resolveAgentType(name: string | undefined, registry: AgentRegistry): AgentDefinition | undefined {
  if (!name) return undefined;
  return registry.get(name);
}

/**
 * Apply a definition's tool policy to a tool list: keep only allowlisted names
 * (when an allowlist is given), then drop any denylisted names. Generic over any
 * object with a `name` so it is unit-testable without real ToolDefinitions.
 */
export function applyToolPolicy<T extends { name: string }>(tools: T[], allow?: string[], deny?: string[]): T[] {
  let out = tools;
  if (allow?.length) {
    const allowSet = new Set(allow);
    out = out.filter((t) => allowSet.has(t.name));
  }
  if (deny?.length) {
    const denySet = new Set(deny);
    out = out.filter((t) => !denySet.has(t.name));
  }
  return out;
}

/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent `.md` invalidates that call's cached result.
 */
export function agentDefinitionKey(def: AgentDefinition | undefined): string | null {
  if (!def) return null;
  return JSON.stringify({
    tools: def.tools ?? null,
    disallowedTools: def.disallowedTools ?? null,
    model: def.model ?? null,
    isolation: def.isolation ?? null,
    prompt: def.prompt,
  });
}

/** List registered agent types for discoverability in the tool guideline. */
export function listAgentTypes(registry: AgentRegistry): Array<{ name: string; description?: string }> {
  return [...registry.values()].map((d) => ({ name: d.name, description: d.description }));
}

// ── write path (agents-manager ticket 02) ────────────────────────────────────

/** Kebab-case rule for agentType names: lowercase words joined by single
 *  dashes, digits allowed but not leading/trailing a dash segment. */
export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/** The writable subset of a definition. `source` is NOT writable — it is a
 *  property of which directory the file lands in, not of the file itself. */
export interface AgentDefinitionWrite {
  name: string;
  description?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  tier?: string;
  isolation?: "worktree";
  prompt: string;
}

/** Quote a frontmatter value unless it is safe as a YAML plain scalar. JSON
 *  double quotes are a YAML-compatible subset, so `JSON.stringify` is the
 *  escape hatch for anything containing `:`/`#`/leading indicators. */
function fmValue(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value) && !value.endsWith(" ") ? value : JSON.stringify(value);
}

/** Serialize a definition to the canonical markdown form. tools/disallowedTools
 *  are written in the comma-separated string form (ticket 14 / decision 09) so
 *  the Claude-Code convention round-trips: write → parseAgentDefinition → same
 *  arrays. Body = prompt, trimmed, one blank line after the frontmatter. */
export function serializeAgentDefinition(def: AgentDefinitionWrite): string {
  const fm: string[] = [`name: ${fmValue(def.name)}`];
  if (def.description) fm.push(`description: ${fmValue(def.description)}`);
  if (def.model) fm.push(`model: ${fmValue(def.model)}`);
  if (def.tier) fm.push(`tier: ${fmValue(def.tier)}`);
  if (def.tools?.length) fm.push(`tools: ${def.tools.join(", ")}`);
  if (def.disallowedTools?.length) fm.push(`disallowedTools: ${def.disallowedTools.join(", ")}`);
  if (def.isolation) fm.push(`isolation: ${def.isolation}`);
  const body = def.prompt.trim();
  return `---\n${fm.join("\n")}\n---\n${body ? `\n${body}\n` : "\n"}`;
}

/**
 * Write a definition to `dir` (the project `.pi/agents` or user `~/.pi/agents`
 * — the caller picks the scope). The canonical filename is `<name>.md`. Throws
 * (never silently coerces) on: invalid name, a core built-in name, a name owned
 * by an extension pack (via `opts.packDirs`), or a second file in `dir` already
 * declaring the same name under a different filename (first-wins would make
 * that pair order-dependent). Overwriting `<name>.md` itself is the edit path.
 * Returns the written path.
 */
export function writeAgentDefinition(dir: string, def: AgentDefinitionWrite, opts?: { packDirs?: string[] }): string {
  const name = def.name.trim();
  if (!isValidAgentName(name)) {
    throw new Error(`invalid agentType name "${name}" — use kebab-case (a-z, 0-9, single dashes)`);
  }
  if (BUILTIN_AGENT_DEFS.some((b) => b.name === name)) {
    throw new Error(`"${name}" is a core built-in agentType — built-ins are read-only`);
  }
  for (const packDir of opts?.packDirs ?? []) {
    if (readDefsFromDir(packDir, "pack").some((d) => d.name === name)) {
      throw new Error(`"${name}" is owned by an extension pack (${packDir}) — pack definitions are read-only`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const canonical = `${name}.md`;
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".md") || file === canonical) continue;
    try {
      const existing = parseAgentDefinition(readFileSync(join(dir, file), "utf-8"), "project", file);
      if (existing?.name === name) {
        throw new Error(`"${name}" is already declared by ${file} — edit or delete that file instead`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("is already declared by")) throw e;
      // An unreadable neighbor can't prove a collision; skip it.
    }
  }
  const target = join(dir, canonical);
  writeFileSync(target, serializeAgentDefinition({ ...def, name }), "utf-8");
  return target;
}

/**
 * Delete the definition `name` from `dir`. Matches by PARSED frontmatter name
 * (a file may legally declare a name different from its filename), not by
 * filename. Throws when the dir is missing or no file declares the name.
 * Returns the removed path.
 */
export function deleteAgentDefinition(dir: string, name: string): string {
  if (!existsSync(dir)) throw new Error(`no agent definitions dir at ${dir}`);
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, file);
    try {
      if (parseAgentDefinition(readFileSync(full, "utf-8"), "project", file)?.name !== name) continue;
    } catch {
      continue;
    }
    unlinkSync(full);
    return full;
  }
  throw new Error(`no agentType named "${name}" in ${dir}`);
}
