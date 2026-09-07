/**
 * agent-type-catalog — the parent router's view of the agentType registry.
 *
 * Claude Code's Task tool description enumerates the available subagent
 * types, so the routing model can PICK one without being told its name.
 * s2-agent's `spawn_subagent.agentType` used to name only the two built-ins —
 * which silently undercut the registry work: a freshly created / live-reloaded
 * project type (e.g. `hard-problem`) was invisible to the very model that is
 * supposed to route to it.
 *
 * The catalog is computed ONCE at tool-creation time (extension registration):
 * project types are on disk before the session starts, and a stable string
 * keeps the schema-cost baseline deterministic. Live-reload semantics are
 * unchanged — spawning by a type created mid-session still works; only the
 * DESCRIPTION's snapshot is from boot.
 */

import { loadAgentRegistry } from "@repo/s2-agent-core-runtime";

/** Catalog block appended to the spawn tools' descriptions. */
export const CATALOG_HEADER = "Available agentTypes";

/** Defaults tuned against the schema-cost budget: a 12-entry, 700-char
 *  catalog costs ~200 tokens on the 25k baseline (+0.8%) — inside the +5%
 *  gate with room for real projects. */
export const DEFAULT_CATALOG_MAX_ENTRIES = 12;
export const DEFAULT_CATALOG_MAX_CHARS = 700;
const DEFAULT_ENTRY_MAX_CHARS = 120;

export interface AgentTypeCatalogOptions {
  maxEntries?: number;
  maxChars?: number;
  entryMaxChars?: number;
}

/** One rendered catalog row: `name — description`. */
export function formatCatalogEntry(
  name: string,
  description: string | undefined,
  entryMaxChars = DEFAULT_ENTRY_MAX_CHARS,
): string {
  const desc = (description ?? "").replace(/\s+/g, " ").trim();
  if (!desc) return name;
  const full = `${name} — ${desc}`;
  return full.length <= entryMaxChars ? full : `${full.slice(0, entryMaxChars - 1)}…`;
}

/**
 * Build the "Available agentTypes: …" catalog string from the registry that
 * `spawn_subagent.agentType` resolves against (same loader, same precedence:
 * project > pack > user > builtin). Deterministic for a given directory
 * state; returns "" only if the registry is somehow empty (built-ins make
 * that unreachable in practice).
 */
export function buildAgentTypeCatalog(cwd: string, opts: AgentTypeCatalogOptions = {}): string {
  const maxEntries = opts.maxEntries ?? DEFAULT_CATALOG_MAX_ENTRIES;
  const maxChars = opts.maxChars ?? DEFAULT_CATALOG_MAX_CHARS;
  const entryMaxChars = opts.entryMaxChars ?? DEFAULT_ENTRY_MAX_CHARS;
  const registry = loadAgentRegistry(cwd);
  const rows: string[] = [];
  let total = 0;
  for (const [name, def] of registry) {
    if (rows.length >= maxEntries) break;
    const row = formatCatalogEntry(name, def.description, entryMaxChars);
    const extra = rows.length === 0 ? row.length : row.length + 2;
    if (total + extra > maxChars) break;
    rows.push(row);
    total += extra;
  }
  return `${CATALOG_HEADER}: ${rows.join("; ")}`;
}

/** Append the catalog to a tool description, on its own sentence boundary. */
export function withAgentTypeCatalog(description: string, catalog: string): string {
  return catalog ? `${description} ${catalog}` : description;
}
