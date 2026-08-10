/**
 * Skill row-model + codec helpers — pure functions and types shared by the
 * skills manager modal (skills-command.ts) and the skills command registration.
 *
 * Extracted verbatim from skills-command.ts (architecture-deepening C2,
 * zero-behavior-change split). This module is leaf-pure: it depends only on
 * ../types.js, node built-ins, and pi-tui's fuzzyFilter.
 */

import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillIndex, SkillScope } from "../types.js";
import { fuzzyFilter } from "@earendil-works/pi-tui";

export const MEMORY_SKILLS_KEYMAP = {
  moveGlobal: "g",
  moveProject: "p",
  deleteSelected: "d",
  cycleSort: "s",
  selectAllFiltered: "a",
  clearSelection: "n",
  focusSearch: "/",
  openFilters: "f",
  toggleSelection: "space",
  switchFocus: "tab",
  close: "esc",
} as const;

export type SkillRowCategory = "G" | "P" | "E";
export type SkillSortMode = "updated" | "created" | "name";

export interface SkillModalRow {
  skillId: string;
  scope?: SkillScope;
  category: SkillRowCategory;
  mutable: boolean;
  name: string;
  displayName: string;
  description: string;
  path: string;
  displayPath: string;
  created?: string;
  updated?: string;
  projectName?: string;
  selected: boolean;
  searchText: string;
}

export interface LoadedSkillRow {
  name: string;
  displayName: string;
  description: string;
  path: string;
  displayPath: string;
  sourceScope?: string;
  sourceOrigin?: string;
  sourceLabel?: string;
}

export interface SkillCommandInfo {
  name: string;
  description?: string;
  source?: string;
  sourceInfo?: {
    path?: string;
    scope?: string;
    source?: string;
    origin?: string;
    baseDir?: string;
  };
}

export interface SkillCategoryFilters {
  global: boolean;
  project: boolean;
  external: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const DEFAULT_SKILL_FILTERS: SkillCategoryFilters = {
  global: true,
  project: true,
  external: true,
};

export function cloneFilters(filters: SkillCategoryFilters): SkillCategoryFilters {
  return {
    global: filters.global,
    project: filters.project,
    external: filters.external,
  };
}

export function ensureValidFilters(filters: SkillCategoryFilters): SkillCategoryFilters {
  if (filters.global || filters.project || filters.external) return filters;
  return { ...DEFAULT_SKILL_FILTERS };
}

export function filtersLabel(filters: SkillCategoryFilters): string {
  const active: string[] = [];
  if (filters.global) active.push("[G]");
  if (filters.project) active.push("[P]");
  if (filters.external) active.push("[E]");
  return active.length > 0 ? active.join(" ") : "(none)";
}

function normalizePathForKey(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const normalized = resolved.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function formatSkillPath(inputPath: string): string {
  const absolutePath = path.resolve(inputPath);
  const home = os.homedir();
  const relative = path.relative(home, absolutePath);
  const underHome = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));

  if (!underHome) return absolutePath;
  if (relative === "") return "~";
  return `~${path.sep}${relative}`;
}

function categoryForScope(scope: SkillScope): SkillRowCategory {
  return scope === "global" ? "G" : "P";
}

function createExternalSkillId(name: string, filePath: string): string {
  const safeName = (name || "skill")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
  const hash = createHash("sha1").update(`${name}|${filePath}`).digest("hex").slice(0, 10);
  return `external:${safeName}:${hash}`;
}

export function matchesCategoryFilter(row: SkillModalRow, filters: SkillCategoryFilters): boolean {
  if (row.category === "G") return filters.global;
  if (row.category === "P") return filters.project;
  return filters.external;
}

function categoryOrder(category: SkillRowCategory): number {
  switch (category) {
    case "G":
      return 0;
    case "P":
      return 1;
    case "E":
      return 2;
  }
}

function recencyValue(row: Pick<SkillModalRow, "updated" | "created">): string {
  return row.updated || row.created || "";
}

export function sortModeLabel(sortMode: SkillSortMode): string {
  switch (sortMode) {
    case "updated":
      return "Updated";
    case "created":
      return "Created";
    case "name":
      return "Name";
  }
}

export function nextSortMode(sortMode: SkillSortMode): SkillSortMode {
  switch (sortMode) {
    case "updated":
      return "created";
    case "created":
      return "name";
    case "name":
      return "updated";
  }
}

export function compareSkillRows(a: SkillModalRow, b: SkillModalRow, sortMode: SkillSortMode): number {
  if (sortMode === "name") {
    const byName = a.displayName.localeCompare(b.displayName);
    if (byName !== 0) return byName;
    return categoryOrder(a.category) - categoryOrder(b.category);
  }

  const primaryA = sortMode === "updated" ? recencyValue(a) : (a.created || "");
  const primaryB = sortMode === "updated" ? recencyValue(b) : (b.created || "");
  if (primaryA || primaryB) {
    if (!primaryA) return 1;
    if (!primaryB) return -1;
    if (primaryA !== primaryB) return primaryB.localeCompare(primaryA);
  }

  if (sortMode === "updated") {
    const createdA = a.created || "";
    const createdB = b.created || "";
    if (createdA || createdB) {
      if (!createdA) return 1;
      if (!createdB) return -1;
      if (createdA !== createdB) return createdB.localeCompare(createdA);
    }
  } else {
    const updatedA = recencyValue(a);
    const updatedB = recencyValue(b);
    if (updatedA || updatedB) {
      if (!updatedA) return 1;
      if (!updatedB) return -1;
      if (updatedA !== updatedB) return updatedB.localeCompare(updatedA);
    }
  }

  const byCategory = categoryOrder(a.category) - categoryOrder(b.category);
  if (byCategory !== 0) return byCategory;
  return a.displayName.localeCompare(b.displayName);
}

export function collectLoadedSkillsFromCommands(commands: SkillCommandInfo[]): LoadedSkillRow[] {
  const loaded: LoadedSkillRow[] = [];

  for (const command of commands) {
    if (!isRecord(command)) continue;
    const source = getStringField(command.source);
    if (source !== "skill") continue;

    const commandName = getStringField(command.name)?.trim();
    if (!commandName) continue;

    const sourceInfo = isRecord(command.sourceInfo) ? command.sourceInfo : undefined;
    const sourcePath = sourceInfo ? getStringField(sourceInfo.path)?.trim() : undefined;
    if (!sourcePath) continue;

    const rawName = commandName.startsWith("skill:")
      ? commandName.slice("skill:".length)
      : commandName;
    const displayName = rawName || commandName;
    const filePath = path.resolve(sourcePath);

    loaded.push({
      name: rawName || commandName,
      displayName,
      description: getStringField(command.description) || "",
      path: filePath,
      displayPath: formatSkillPath(filePath),
      sourceScope: sourceInfo ? getStringField(sourceInfo.scope) : undefined,
      sourceOrigin: sourceInfo ? getStringField(sourceInfo.origin) : undefined,
      sourceLabel: sourceInfo ? getStringField(sourceInfo.source) : undefined,
    });
  }

  return loaded.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function formatSkillsList(rows: SkillModalRow[], projectName: string | null): string {
  const globalSkills = rows.filter((row) => row.category === "G");
  const projectSkills = rows.filter((row) => row.category === "P");
  const externalSkills = rows.filter((row) => row.category === "E");

  const lines: string[] = [];
  lines.push("");
  lines.push("  ╔═══════════════════════════════════════════════════════════╗");
  lines.push("  ║                    🧠 Procedural Skills                  ║");
  lines.push("  ╚═══════════════════════════════════════════════════════════╝");
  lines.push("  Legend: [G] global · [P] project · [E] external (read-only)");
  lines.push("");

  if (rows.length === 0) {
    lines.push("  (no skills found in this session)");
    lines.push("");
    lines.push("  Ask the agent to save a reusable procedure");
    lines.push("  with the skill_manage tool when it is worth keeping.");
    return lines.join("\n");
  }

  if (globalSkills.length > 0) {
    lines.push("  [G] Global Skills");
    lines.push("  ─────────────────");
    for (const row of globalSkills) {
      lines.push(`  📄 ${row.displayName} (${row.displayPath})`);
      lines.push(`     ${row.description || "(no description)"}`);
      lines.push(`     id: ${row.skillId}`);
      lines.push("");
    }
  }

  if (projectSkills.length > 0) {
    lines.push(`  [P] Project Skills${projectName ? ` (${projectName})` : ""}`);
    lines.push("  ─────────────────────────────────");
    for (const row of projectSkills) {
      lines.push(`  📄 ${row.displayName} (${row.displayPath})`);
      lines.push(`     ${row.description || "(no description)"}`);
      lines.push(`     id: ${row.skillId}`);
      lines.push("");
    }
  }

  if (externalSkills.length > 0) {
    lines.push("  [E] External Skills (read-only)");
    lines.push("  ───────────────────────────────");
    for (const row of externalSkills) {
      lines.push(`  📄 ${row.displayName} (${row.displayPath})`);
      lines.push(`     ${row.description || "(no description)"}`);
      lines.push(`     id: ${row.skillId}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildSkillRows(skills: SkillIndex[], selectedSkillIds = new Set<string>()): SkillModalRow[] {
  return skills.map((skill) => {
    const displayName = skill.displayName || skill.name;
    const displayPath = formatSkillPath(skill.path);
    return {
      skillId: skill.skillId,
      scope: skill.scope,
      category: categoryForScope(skill.scope),
      mutable: true,
      name: skill.name,
      displayName,
      description: skill.description,
      path: skill.path,
      displayPath,
      created: skill.created,
      updated: skill.updated,
      projectName: skill.projectName,
      selected: selectedSkillIds.has(skill.skillId),
      searchText: `${displayName} ${skill.name} ${skill.description || ""} ${skill.path} ${displayPath}`.trim(),
    };
  });
}

export function buildUnifiedSkillRows(
  managedSkills: SkillIndex[],
  loadedSkills: LoadedSkillRow[],
  selectedSkillIds = new Set<string>(),
  sortMode: SkillSortMode = "updated",
): SkillModalRow[] {
  const managedRows = buildSkillRows(managedSkills, selectedSkillIds);
  const managedPathKeys = new Set(managedRows.map((row) => normalizePathForKey(row.path)));
  const externalPathKeys = new Set<string>();

  const externalRows: SkillModalRow[] = [];
  for (const loaded of loadedSkills) {
    const loadedKey = normalizePathForKey(loaded.path);
    if (managedPathKeys.has(loadedKey)) continue;
    if (externalPathKeys.has(loadedKey)) continue;
    externalPathKeys.add(loadedKey);

    const externalSkillId = createExternalSkillId(loaded.name, loaded.path);
    externalRows.push({
      skillId: externalSkillId,
      scope: undefined,
      category: "E",
      mutable: false,
      name: loaded.name,
      displayName: loaded.displayName,
      description: loaded.description,
      path: loaded.path,
      displayPath: loaded.displayPath,
      selected: selectedSkillIds.has(externalSkillId),
      searchText: `${loaded.displayName} ${loaded.name} ${loaded.description || ""} ${loaded.path} ${loaded.displayPath}`.trim(),
    });
  }

  return [...managedRows, ...externalRows].sort((a, b) => compareSkillRows(a, b, sortMode));
}

export function filterSkillRows(rows: SkillModalRow[], query: string): SkillModalRow[] {
  const trimmed = query.trim();
  if (!trimmed) return rows;
  return fuzzyFilter(rows, trimmed, (row) => row.searchText);
}

export function getSelectedSkillIds(rows: SkillModalRow[]): string[] {
  return rows.filter((row) => row.selected).map((row) => row.skillId);
}
