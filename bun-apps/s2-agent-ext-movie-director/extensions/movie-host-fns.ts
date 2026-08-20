/**
 * movie-host-fns.ts — register the movie.* deterministic host-fns over the
 * workflow event bus so WORKFLOW-EXTENSION-driven runs (the `workflow` tool,
 * `/workflows run`, the keyword trigger) can `call('movie.<command>', args)`.
 *
 * (movie-director's OWN /command handlers use buildMovieHostFnRegistry() from
 * src/host-fns.ts and pass it explicitly to runWorkflow — that path does NOT
 * go through this bus; see extensions/movie-workflows.ts.)
 *
 * Mirrors pi-knowledge-card's zk.* registration: idempotent (the runtime
 * overwrites on re-register); re-emit on `request` so we still register if we
 * loaded before the workflow extension's listener existed. No-op if the
 * workflow ext is absent (no `pi.events`).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildMovieHostFnEntries } from "../src/host-fns.ts";

type Bus = {
  emit: (channel: string, payload: unknown) => void;
  on: (channel: string, cb: (payload: unknown) => void) => void;
};

export function registerMovieHostFns(pi: ExtensionAPI): void {
  const bus = (pi as unknown as { events?: Bus }).events;
  if (!bus) return;
  const register = () => {
    for (const entry of buildMovieHostFnEntries()) {
      bus.emit("workflow:hostfn:v1:register", entry);
    }
  };
  // Eager emit (covers the normal load order: we load after the workflow ext's
  // listener exists) + re-emit on request (covers the reverse order).
  register();
  bus.on("workflow:hostfn:v1:request", register);
}
