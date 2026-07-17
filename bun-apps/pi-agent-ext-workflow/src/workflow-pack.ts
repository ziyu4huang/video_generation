/**
 * workflow-pack.ts — the shared workflow-pack resolver + orchestration.
 *
 * This is the SINGLE source of truth for resolving a workflow `<name>` (or path)
 * to runnable script text, shared by BOTH entry paths:
 *   - Path A: `pi-agent-cli workflow run <name>` (headless CLI meta-command)
 *   - Path B: the `workflow` tool's `name` parameter (interactive TUI session)
 *
 * Resolution order (first hit wins):
 *   1. `<name>` as a literal path (absolute, or relative to cwd) when it exists.
 *      A directory here is a workflow pack (folder + manifest.json + entry).
 *   2. `.pi/workflows/<name>` — a pack dir wins over a same-name `.js` file.
 *   3. `bun-apps/<pkg>/workflows/<name>` — same pack-over-file precedence.
 *   4. The literal `<name>` with a `.js` suffix tried in (2) and (3).
 *
 * Pure + injectable (read/exists/stat/readdir default to node:fs) so contract
 * tests exercise every branch without touching disk or an LLM. The orchestration
 * (`runWorkflowScript`) calls this package's own `runWorkflow` / `parseWorkflowScript`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { WorkflowAgent } from "./agent.js";
import { runWorkflow, parseWorkflowScript } from "./workflow.js";
import { readManifest, type Manifest } from "./workflow-pack-manifest.js";

/** Where engine workflow scripts live (project-local, under PWD/.pi). */
export const PI_WORKFLOWS_DIR = ".pi/workflows";
/** Package-local engine workflow script directories. */
export const PKG_WORKFLOWS_GLOB = "bun-apps";
/** Default run-log output dir (under PWD/.pi). Override via --out-dir / PI_WORKFLOWS_OUT_DIR. */
export const DEFAULT_RUNS_DIR = ".pi/workflows/runs";

/** Injectable filesystem so resolver tests run hermetically (no disk). Every
 *  field defaults to node:fs; `stat` returns undefined on missing (like statSyncOrNull). */
export interface WorkflowPackFs {
  read?: (p: string) => string;
  exists?: (p: string) => boolean;
  stat?: (p: string) => { isFile: () => boolean; isDirectory: () => boolean } | undefined;
  readdir?: (p: string) => string[];
}

export interface ResolvedWorkflow {
  /** Absolute path to the entry script that was read (the .js/.mjs for a
   *  single file, or the pack's entry file for a workflow pack). */
  path: string;
  /** Entry script source text. */
  script: string;
  /** How it was resolved, for the run receipt. */
  source: "path" | ".pi/workflows" | "package-workflows";
  /** Present iff a workflow pack (folder + manifest.json). The manifest carries
   *  default args/model/thinking the runner merges under CLI flags. */
  pack?: { manifest: Manifest; packDir: string };
}

/** A slim projection of ResolvedWorkflow for tool callers that only need the
 *  script + manifest (not the full pack tuple). Returned by `resolveWorkflowPack`. */
export interface ResolvedWorkflowPack {
  script: string;
  manifest?: Manifest;
  source: ResolvedWorkflow["source"];
  packDir?: string;
  /** Absolute path to the entry script that was read. */
  entryPath: string;
}

/** Stats a path, returning undefined on ENOENT/etc. Use `?.isFile()` — undefined
 *  (unlike `false`) is nullish so the optional-chaining narrows correctly. */
function statSyncOrNull(p: string): { isFile: () => boolean; isDirectory: () => boolean } | undefined {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

/** readdirSync that returns [] on error (missing dir, permission, …). */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalize the injectable fs opts to a fully-populated set (defaults filled). */
function resolveFs(opts: WorkflowPackFs): Required<WorkflowPackFs> {
  return {
    read: opts.read ?? ((p) => readFileSync(p, "utf8")),
    exists: opts.exists ?? ((p) => existsSync(p)),
    stat: opts.stat ?? statSyncOrNull,
    readdir: opts.readdir ?? readdirSyncSafe,
  };
}

/**
 * Resolve a workflow `<name>` (or path) to its script text. Pure + injectable
 * (read/exists/stat/readdir + cwd) so the contract test can exercise every
 * branch without touching the engine or an LLM.
 */
export function resolveWorkflowScript(name: string, opts: { cwd?: string } & WorkflowPackFs = {}): ResolvedWorkflow {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error(`workflow: a script name or path is required (got "${name}")`);
  }
  const cwd = opts.cwd ?? process.cwd();
  const fs = resolveFs(opts);

  // 1. Literal path: a file OR a workflow-pack directory (manifest.json + entry).
  const asPath = isAbsolute(name) ? name : resolve(cwd, name);
  const pathStat = fs.stat(asPath);
  if (pathStat?.isFile()) {
    return { path: asPath, script: fs.read(asPath), source: "path" };
  }
  if (pathStat?.isDirectory()) {
    const pack = tryResolvePack(asPath, fs);
    if (pack) return { ...pack, source: "path" };
    // A directory that isn't a pack is an error, not a silent fall-through.
    throw new Error(
      `workflow: "${name}" is a directory without a manifest.json (not a workflow pack): ${asPath}`,
    );
  }

  // Candidate names with and without the .js suffix (so `workflow run foo`
  // and `workflow run foo.js` both work). Used only for single-file lookup.
  const names = name.endsWith(".js") ? [name] : [`${name}.js`, name];

  // 2-3. Name resolution under the workflow dirs. Per location, a workflow-pack
  //      directory (<name>/manifest.json) wins over a same-name file — packs
  //      are the richer, deliberate artifact.
  const root = findRepoRoot(cwd, fs.exists);
  if (root) {
    const piDir = join(root, PI_WORKFLOWS_DIR);
    if (fs.exists(piDir)) {
      const pack = tryResolvePack(join(piDir, name), fs);
      if (pack) return { ...pack, source: ".pi/workflows" };
      for (const candidate of names) {
        const p = join(piDir, candidate);
        if (fs.exists(p) && fs.stat(p)?.isFile()) {
          return { path: p, script: fs.read(p), source: ".pi/workflows" };
        }
      }
    }

    const pkgRoot = join(root, PKG_WORKFLOWS_GLOB);
    if (fs.exists(pkgRoot) && fs.stat(pkgRoot)?.isDirectory()) {
      for (const pkg of fs.readdir(pkgRoot)) {
        const pkgDir = join(pkgRoot, pkg, "workflows");
        if (!fs.exists(pkgDir)) continue;
        const pack = tryResolvePack(join(pkgDir, name), fs);
        if (pack) return { ...pack, source: "package-workflows" };
        for (const candidate of names) {
          const p = join(pkgDir, candidate);
          if (fs.exists(p) && fs.stat(p)?.isFile()) {
            return { path: p, script: fs.read(p), source: "package-workflows" };
          }
        }
      }
    }
  }

  throw new Error(
    `workflow: script "${name}" not found.\n` +
      `Looked for: ${asPath}\n` +
      (root
        ? `  ${join(root, PI_WORKFLOWS_DIR, names[0]!)}\n` +
          `  ${join(root, PKG_WORKFLOWS_GLOB, "<pkg>", "workflows", names[0]!)}\n`
        : "") +
      `Pass an absolute path or a name under .pi/workflows/ or bun-apps/<pkg>/workflows/.`,
  );
}

/** Resolve a workflow `<name>` (or path) to a slim pack view (script + manifest).
 *  Thin projection over `resolveWorkflowScript` — the convenience tool callers use. */
export function resolveWorkflowPack(name: string, opts: { cwd?: string } & WorkflowPackFs = {}): ResolvedWorkflowPack {
  const r = resolveWorkflowScript(name, opts);
  return {
    script: r.script,
    manifest: r.pack?.manifest,
    source: r.source,
    packDir: r.pack?.packDir,
    entryPath: r.path,
  };
}

/** Resolve a workflow pack at `packDir`: validate its manifest.json (via
 *  readManifest) then read the entry script text. Returns the entry path/script
 *  + the validated manifest, or undefined when `packDir` has no manifest.json
 *  (not a pack). Throws on a malformed pack (bad manifest, or entry missing). */
function tryResolvePack(
  packDir: string,
  fs: Required<WorkflowPackFs>,
): { path: string; script: string; pack: { manifest: Manifest; packDir: string } } | undefined {
  if (!fs.exists(join(packDir, "manifest.json"))) return undefined;
  const manifest = readManifest(packDir, { read: fs.read, exists: fs.exists });
  const entryPath = join(packDir, manifest.entry);
  if (!fs.exists(entryPath) || !fs.stat(entryPath)?.isFile()) {
    throw new Error(`workflow: pack entry "${manifest.entry}" not found in ${packDir}`);
  }
  return { path: entryPath, script: fs.read(entryPath), pack: { manifest, packDir } };
}

/**
 * Walk up from `start` to the first dir containing `.pi/workflows/` or a
 * `bun-apps/` dir — the project root for workflow-script resolution. Falls back
 * to undefined when no such root is found (an absolute-path run still resolves
 * via the literal-path branch). Pure (uses the injected `exists`).
 */
export function findRepoRoot(start: string, exists: (p: string) => boolean): string | undefined {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (exists(join(dir, PI_WORKFLOWS_DIR)) || exists(join(dir, PKG_WORKFLOWS_GLOB))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Shallow-merge manifest default args under CLI/caller args (Decision 5: caller
 *  wins). Both plain objects → merged; otherwise the caller value replaces entirely. */
export function mergeArgs(manifestArgs: unknown, callerArgs: unknown): unknown {
  if (callerArgs === undefined) return manifestArgs;
  if (manifestArgs === undefined) return callerArgs;
  if (isPlainObject(manifestArgs) && isPlainObject(callerArgs)) {
    return { ...(manifestArgs as Record<string, unknown>), ...(callerArgs as Record<string, unknown>) };
  }
  return callerArgs;
}

/** Resolve effective args/model for a run: manifest provides defaults, the
 *  caller (CLI flags / tool args) overrides (Decision 5). Pure. */
export function resolvePackOverrides(
  pack: { manifest: Manifest } | undefined,
  caller: { args?: unknown; model?: string },
): { args: unknown; model?: string } {
  return {
    args: mergeArgs(pack?.manifest.args, caller.args),
    model: caller.model ?? pack?.manifest.model,
  };
}

/**
 * Resolve the run-log output dir for a workflow run. Absolute paths are kept;
 * relative paths resolve against `cwd`. Falls back to the PWD/.pi default.
 * Pure — the env read is done by the caller (the CLI command layer) so this
 * stays testable; pass the resolved override (or undefined) here.
 */
export function resolveRunsDir(outDir: string | undefined, cwd?: string): string {
  const base = cwd ?? process.cwd();
  const dir = outDir ?? DEFAULT_RUNS_DIR;
  return isAbsolute(dir) ? dir : resolve(base, dir);
}

export interface WorkflowListRow {
  source: string;
  name: string;
  description: string;
  /** "pack" = folder + manifest.json; "file" = single-file .js script. */
  kind: "pack" | "file";
}

export interface WorkflowListResult {
  rows: WorkflowListRow[];
  errors: { path: string; message: string }[];
}

/** Enumerate resolvable workflows under a repo root: workflow packs (folders
 *  with manifest.json) AND single-file scripts (*.js). Pack rows render from
 *  the manifest; file rows from `export const meta`. Broken packs/scripts are
 *  reported in `errors` (not dropped). Injectable fs for hermetic tests. */
export function listWorkflows(claudeRoot: string, opts: WorkflowPackFs = {}): WorkflowListResult {
  const fs = resolveFs(opts);
  const dirs = [
    { label: ".pi/workflows", dir: join(claudeRoot, PI_WORKFLOWS_DIR) },
    ...fs.readdir(join(claudeRoot, PKG_WORKFLOWS_GLOB)).map((pkg) => ({
      label: `bun-apps/${pkg}/workflows`,
      dir: join(claudeRoot, PKG_WORKFLOWS_GLOB, pkg, "workflows"),
    })),
  ];
  const rows: WorkflowListRow[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const { label, dir } of dirs) {
    if (!fs.exists(dir)) continue;
    for (const entry of fs.readdir(dir)) {
      const p = join(dir, entry);
      const stat = fs.stat(p);
      if (stat?.isDirectory()) {
        // A workflow pack — only when it has a manifest.json.
        if (!fs.exists(join(p, "manifest.json"))) continue;
        try {
          const manifest = readManifest(p, { read: fs.read, exists: fs.exists });
          rows.push({ source: label, name: manifest.name, description: manifest.description, kind: "pack" });
        } catch (e) {
          errors.push({ path: p, message: (e as Error).message.split("\n")[0]! });
        }
        continue;
      }
      if (!stat?.isFile() || !entry.endsWith(".js")) continue;
      try {
        const { meta } = parseWorkflowScript(fs.read(p));
        rows.push({ source: label, name: meta.name, description: meta.description, kind: "file" });
      } catch (e) {
        errors.push({ path: p, message: (e as Error).message.split("\n")[0]! });
      }
    }
  }
  return { rows, errors };
}

export interface RunWorkflowScriptOptions {
  name: string;
  args?: unknown;
  model?: string;
  dryRun?: boolean;
  persistLogs?: boolean;
  cwd?: string;
  /**
   * Run-log output dir (absolute or relative to cwd). Default
   * `PWD/.pi/workflows/runs`. Also overridable via PI_WORKFLOWS_OUT_DIR env at
   * the CLI command layer; this field is the resolved value passed to the engine.
   */
  outDir?: string;
  /**
   * Injectable agent (the LLM caller). Defaults to a real WorkflowAgent; tests
   * pass a stub so the engine's gates run without network/LLM access. Typed to
   * match `Pick<WorkflowAgent, "run">` so it threads straight into runWorkflow.
   */
  agent?: Pick<WorkflowAgent, "run">;
  /**
   * Streaming callbacks so a caller (CLI) can show phase/agent progress. Same
   * shapes as runWorkflow's onPhase/onAgentEnd.
   */
  onPhase?: (title: string) => void;
  onAgentEnd?: (event: { label: string; phase?: string; result: unknown; error?: string }) => void;
}

/**
 * Core runner: resolve → (dry-run validates only) → runWorkflow. Returns the
 * engine's receipt plus the resolved script path. Exported so the CLI command
 * and contract tests drive it with a stub agent and no LLM.
 */
export async function runWorkflowScript(
  opts: RunWorkflowScriptOptions,
): Promise<{
  meta: { name: string; description: string };
  result: unknown;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  scriptPath: string;
  source: ResolvedWorkflow["source"];
  dryRun: boolean;
}> {
  const resolved = resolveWorkflowScript(opts.name, { cwd: opts.cwd });
  const { meta } = parseWorkflowScript(resolved.script);
  const overrides = resolvePackOverrides(resolved.pack, { args: opts.args, model: opts.model });
  // A pack identifies itself by its manifest; a single-file script by its meta.
  const identity = resolved.pack
    ? { name: resolved.pack.manifest.name, description: resolved.pack.manifest.description }
    : { name: meta.name, description: meta.description };

  if (opts.dryRun) {
    return {
      meta: identity,
      result: { validated: true },
      logs: [
        `dry-run: ${resolved.pack ? `pack "${identity.name}"` : `script "${meta.name}"`} parsed and validated (${resolved.path})`,
      ],
      phases: [],
      agentCount: 0,
      durationMs: 0,
      scriptPath: resolved.path,
      source: resolved.source,
      dryRun: true,
    };
  }

  const receipt = await runWorkflow(resolved.script, {
    args: overrides.args,
    mainModel: overrides.model,
    persistLogs: opts.persistLogs ?? true,
    cwd: opts.cwd,
    runsDir: resolveRunsDir(opts.outDir, opts.cwd),
    ...(opts.agent ? { agent: opts.agent } : {}),
    onPhase: opts.onPhase,
    onAgentEnd: opts.onAgentEnd as any,
  });

  return {
    meta: identity,
    result: receipt.result,
    logs: receipt.logs,
    phases: receipt.phases,
    agentCount: receipt.agentCount,
    durationMs: receipt.durationMs,
    runId: receipt.runId,
    scriptPath: resolved.path,
    source: resolved.source,
    dryRun: false,
  };
}
