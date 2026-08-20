/**
 * Detach pipeline (Task 05, cc-subagent-tui): convert a FOREGROUND subagent
 * run to BACKGROUND, live.
 *
 * Design (spec §3):
 *   - the child SURVIVES: a NEW OS subprocess, spawned `detached: true` +
 *     `unref()`, resumes the run from a persistence manifest flushed at detach
 *     time — it outlives the parent turn and even the parent process;
 *   - the registry keeps the entry LIVE (foreground flips false → the run
 *     appears in the subagents section immediately; `abort` rebinds to the
 *     detached child's kill lever);
 *   - persistence owns recovery: the resume-safe manifest is the source of
 *     truth; if the parent dies, the detached subprocess finishes and its own
 *     completed-record write records the result;
 *   - the parent releases WITHOUT killing: the awaited tool call resolves with
 *     outcome "detached" (dispatchChild observes the registry's detached flag
 *     via `onDetach`) and the parent turn resumes.
 *
 * The capability is a FUNCTION, not a keybinding — Task 06 wires the detach
 * keys (alt+s global + ctrl+b in-viewer) on top of
 * `convertToBackground`/`makeProdDetachDeps`.
 */
import { spawn } from "node:child_process";
import type { SubagentInFlightRegistry } from "@repo/pi-agent-core-runtime";
import {
  buildSubagentArgs,
  getPiInvocation,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
  isTerminalStatus,
  type SubagentRunPersistence,
} from "@repo/pi-agent-core-runtime";

// ---- Public surface (Task 06/08 consume exactly this) ----------------------

/** One detached run's spawn inputs — the manifest is the resume source. */
export interface DetachedSpawnSpec {
  id: string;
  agent?: string;
  /** FULL raw task prompt (not the 80-char preview). */
  task: string;
  cwd: string;
  manifestPath: string;
}

/** Handle onto the detached OS subprocess. `kill` is the rebound abort lever. */
export interface DetachedChildHandle {
  pid: number | undefined;
  kill(): void;
}

export type DetachedSpawn = (spec: DetachedSpawnSpec) => DetachedChildHandle;

export type DetachOutcome = { ok: true; runId: string } | { ok: false; error: string };

/** All IO seams of the detach conversion, injectable for tests. */
export interface DetachDeps {
  registry: SubagentInFlightRegistry;
  /** Prod: {@link spawnDetachedChild}. */
  spawnDetached: DetachedSpawn;
  /** Flushes the run's live history/task to a resume manifest; returns path. */
  persistRun: (id: string) => string;
}

// ---- Conversion -----------------------------------------------------------

/**
 * Convert a foreground run to background. Refuses (never throws) an unknown
 * id, an already-background run, or a terminal run — those detach attempts
 * return `{ ok: false, error }` so the caller can surface why nothing moved.
 */
export function convertToBackground(id: string, deps: DetachDeps): DetachOutcome {
  const view = deps.registry.view(id);
  if (!view) return { ok: false, error: `unknown run: ${id}` };
  if (!view.foreground) return { ok: false, error: `run ${id} is already background` };
  if (isTerminalStatus(view.status)) return { ok: false, error: `run ${id} already terminal` };
  // 1) persistence owns recovery: flush live history/task to a resume manifest FIRST
  const manifestPath = deps.persistRun(id);
  // 2) child survives: detached OS subprocess resumes from the manifest
  const child = deps.spawnDetached({
    id,
    agent: view.actor === "general-purpose" ? undefined : view.actor,
    task: view.task ?? view.taskPreview,
    cwd: process.cwd(),
    manifestPath,
  });
  // 3) registry keeps the entry live; foreground flips false (→ the subagents
  //    section); abort rebinds to the detached child's kill lever. markDetached
  //    also fires the onDetach watcher that resolves the parent's awaited tool
  //    call with outcome "detached" (dispatchChild's subscription).
  deps.registry.markDetached(id, { abort: () => child.kill() });
  // 4) parent releases WITHOUT kill: the awaited tool call resolves "detached".
  return { ok: true, runId: id };
}

// ---- Prod detached spawn --------------------------------------------------

/**
 * Spawn the detached resume subprocess. Self-resolves the pi launcher from the
 * parent's own runtime + entry (same rule as spawnSubagentSubprocess — never a
 * bare `pi` from PATH). The child's task is the ORIGINAL task plus a resume
 * preamble pointing at the progress manifest; `detached: true` puts it in a
 * new process group (survives parent turn/session end) and `unref()` frees the
 * parent's event loop so the parent may exit while the child finishes.
 */
export function spawnDetachedChild(spec: DetachedSpawnSpec): DetachedChildHandle {
  const resumePrompt = [
    spec.agent
      ? `You are the ${spec.agent}, resuming a subagent run that was detached to the background (run ${spec.id}).`
      : `You are resuming a subagent run that was detached to the background (run ${spec.id}).`,
    `Prior progress transcript manifest (JSON, inspection only): ${spec.manifestPath}`,
    spec.task,
  ].join("\n\n");
  const inv = getPiInvocation([...buildSubagentArgs(undefined, {}), resumePrompt]);
  const proc = spawn(inv.command, inv.args, {
    detached: true, // new process group — survives parent turn/session end
    stdio: "ignore",
    cwd: spec.cwd,
  });
  proc.unref(); // parent may exit; the event loop is NOT held
  return { pid: proc.pid, kill: () => proc.kill("SIGTERM") };
}

// ---- Shared prod assembly (Task 06 global + in-viewer paths reuse this) ----

/**
 * Assemble the production `DetachDeps`: the shared in-flight registry, the
 * real detached spawn, and a `persistRun` that flushes a resumable manifest
 * through the run-persistence singleton. Overrides exist for tests only.
 */
export function makeProdDetachDeps(
  opts: { registry?: SubagentInFlightRegistry; persistence?: SubagentRunPersistence } = {},
): DetachDeps {
  const registry = opts.registry ?? getSubagentInFlightRegistry();
  const persistence = opts.persistence ?? getSubagentRunPersistence();
  return {
    registry,
    spawnDetached: spawnDetachedChild,
    persistRun: (id: string) => {
      const view = registry.view(id);
      if (!view) throw new Error(`unknown run: ${id}`);
      return persistence.saveDetached({
        id,
        toolCallId: id,
        agent: view.actor === "general-purpose" ? undefined : view.actor,
        task: view.task ?? view.taskPreview,
        model: view.modelSeg,
        cwd: process.cwd(),
        detachedAt: new Date().toISOString(),
        history: [...view.history],
      });
    },
  };
}
