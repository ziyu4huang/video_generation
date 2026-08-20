/**
 * Project detection — determines whether the current working directory
 * represents a project and resolves its name.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { resolveProjectsRoot } from "./paths.js";

export interface ProjectInfo {
  /** Project name (directory basename), or null if not in a project. */
  name: string | null;
  /** Path to the project-scoped memory directory, or null. */
  memoryDir: string | null;
}

export interface ProjectSkillInfo extends ProjectInfo {
  /** Path to the project-scoped skills directory, or null. */
  skillsDir: string | null;
}

/**
 * Detect project from the current working directory.
 *
 * A "project" is any directory that is not the user's home directory.
 * The project name is the directory's basename.
 * Project-scoped memory is stored at ~/.pi/agent/<projectsMemoryDir>/<projectName>/.
 */
export function detectProject(projectsMemoryDir = "projects-memory", cwd?: string, projectNameOverride?: string): ProjectInfo {
  const dir = cwd ?? process.cwd();
  const homeDir = os.homedir();

  // Normalize paths for comparison
  const resolved = path.resolve(dir);
  const resolvedHome = path.resolve(homeDir);

  if (resolved === resolvedHome || resolved === "/" || !resolved || resolved === resolvedHome + "/") {
    return { name: null, memoryDir: null };
  }

  const basename = path.basename(resolved);
  if (!basename || basename === "." || basename === "..") {
    return { name: null, memoryDir: null };
  }

  // ticket 09 — cross-worktree tag coherence: a repo-local `projectName`
  // override wins over the cwd basename so all worktrees of one repo share one
  // project tag (8 worktrees → 8 basenames would otherwise fragment the DB).
  const override = projectNameOverride?.trim();
  const name = override || basename;

  return {
    name,
    memoryDir: path.join(resolveProjectsRoot(projectsMemoryDir), name),
  };
}

export function detectProjectSkills(projectsMemoryDir = "projects-memory", cwd?: string): ProjectSkillInfo {
  const project = detectProject(projectsMemoryDir, cwd);
  return {
    ...project,
    skillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
  };
}

/**
 * Resolve the project-scoped memory store directory (ticket 04, decision 01).
 *
 * The project memory's markdown source-of-truth location. detectProject gives
 * the legacy global location (~/.pi/agent/<projectsMemoryDir>/<project>/); this
 * resolver applies the `projectMemoryDir` config knob on top of it:
 *
 * - default (undefined): <cwd>/.agents/memory/ — in-repo, git-trackable,
 *   per-project (each repo's own .agents/memory/). Chosen over .planning/memory so
 *   auto-managed runtime memory doesn't conflate with hand-authored .planning/
 *   wayfinder artifacts; mirrors the global ~/.agents/ convention. A .claude/memory
 *   symlink → ../.agents/memory is the recommended discoverability marker for
 *   claude-code (which reads CLAUDE.md/.claude, not this dir automatically). Only
 *   created when a project is detected, so running from ~ doesn't create ~/.agents/.
 * - explicit null: opt-out → the legacy global location (detected.memoryDir).
 *   Current behavior preserved for projects that want memory to follow the
 *   user, not the repo.
 * - explicit string: that path, resolved cwd-relative if relative.
 *
 * PURE: deterministic given the inputs — unit-tested independently of index.ts.
 */
export function resolveProjectStoreDir(
  projectMemoryDir: string | null | undefined,
  detected: ProjectInfo,
  cwd: string,
): string | null {
  if (projectMemoryDir === null) return detected.memoryDir;
  if (typeof projectMemoryDir === "string" && projectMemoryDir.trim()) {
    return path.resolve(cwd, projectMemoryDir.trim());
  }
  return detected.name ? path.join(cwd, ".agents", "memory") : null;
}

/**
 * Can the project memory store actually live at `dir`?
 *
 * detectProject's rule is "any directory that is not $HOME is a project", which
 * is right for a working copy and wrong for a directory the user is merely
 * standing in. The case that made this real: running the DEPLOYED s2-agent
 * binary from inside its own installation tree. That tree is frozen (the sh
 * deploy chmod's it a-w), so the default `<cwd>/.agents/memory/` resolved to a
 * path under it and the store's mkdir threw straight out of session_start —
 * surfacing as `Extension error (<inline:hermes-memory>): EACCES`.
 *
 * Probing by creating is deliberate: it is exactly what the store does a moment
 * later, so a true answer here means the store will succeed, and there is no
 * TOCTOU gap worth worrying about. The directory it creates is the one that was
 * going to be created anyway.
 */
export function canHoldProjectStore(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
