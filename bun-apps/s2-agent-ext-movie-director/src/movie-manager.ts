/**
 * movie-manager.ts — builds the WorkflowManager that makes the /movie saved
 * workflows crash-resumable.
 *
 * Routing the /command handlers through WorkflowManager (instead of bare
 * runWorkflow) is what makes them resumable: the manager wires
 * onAgentJournal → persistRun (durable journal), recoverStaleRuns (a process
 * that died mid-run is reconciled "running" → "paused" so its journal survives
 * and resume() can replay the completed prefix), and resume(runId).
 *
 * A FRESH manager is built per command invocation (not cached): it avoids
 * accumulating `mgr.on(...)` listeners across invocations and runs
 * recoverStaleRuns on every call (so a crash leftover from a previous process
 * is reconciled before the new run starts). Construction is cheap; movie
 * commands are foreground/blocking so there is no concurrency concern.
 */
import type { WorkflowManager } from "@repo/s2-agent-ext-ultracode";
import { WorkflowManager as WM, createWebTools } from "@repo/s2-agent-ext-ultracode";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { buildMovieHostFnRegistry } from "./host-fns.ts";

export interface MovieManagerOptions {
  /** Resolve a nested workflow() name to its script (e.g. produce-video → scene-assets). */
  loadSavedWorkflow?: (name: string) => string | undefined;
}

export type MovieManagerFactory = (cwd: string, opts: MovieManagerOptions) => WorkflowManager;

export function createMovieManager(cwd: string, opts: MovieManagerOptions = {}): WorkflowManager {
  const mgr = new WM({ cwd, loadSavedWorkflow: opts.loadSavedWorkflow });
  // setHostFns()'s param type is the workflow package's HostFnRegistry CLASS
  // (private `fns` field), so no plain object can structurally satisfy it —
  // but runtime only ever calls .get()/.has()/.list() on it (see
  // call-global.ts), which this duck-typed registry fully implements. Cast
  // past the class-vs-object mismatch rather than depending on a private
  // sibling-package type.
  mgr.setHostFns(buildMovieHostFnRegistry() as unknown as Parameters<typeof mgr.setHostFns>[0]);
  mgr.setExtensionTools([...createCodingTools(cwd), ...createWebTools()]);
  return mgr;
}
