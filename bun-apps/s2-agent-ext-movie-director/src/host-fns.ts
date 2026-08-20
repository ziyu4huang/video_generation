/**
 * host-fns.ts — wrap each `dispatch()` command as a workflow host-fn so a
 * workflow script can `call('movie.<command>', args)` the deterministic
 * orchestration core (zero-token, journaled). Mirrors pi-knowledge-card's
 * schemaless zk.* adapters.
 *
 * Two surfaces, one source of entries (buildMovieHostFnEntries):
 *   • buildMovieHostFnRegistry()  → duck-typed {get,has,list} for runWorkflow's
 *     explicit `options.hostFns` (movie-director's OWN /command handlers).
 *   • the event-bus payloads emitted by extensions/movie-host-fns.ts → for
 *     workflow-EXTENSION-driven runs (workflow tool / /workflows run).
 *
 * NOTE on schemas: workflow applies a host-fn's `schema` to the RETURN value
 * (not the args). Mirroring every command's exact return shape is brittle and
 * redundant — dispatch already validates inputs (missingFields) and artifacts
 * (validate-artifact). So we register SCHEMALESS host-fns, exactly like zk.*.
 *
 * Pure Bun (no pi-SDK, no workflow import) so it is unit-testable in isolation.
 */
import { dispatch, COMMANDS, coerceOptions, type Command } from "./dispatch.ts";
import { markMovieActive } from "./session-state.ts";

/** Context handed to every movie.* host fn (matches workflow's HostFnCtx shape). */
export interface MovieHostFnCtx {
  cwd: string;
  signal: AbortSignal;
  runId: string;
}

/** Per-command timeout (ms). GPU/compose work is long; pure orchestration is fast. */
export const HOST_FN_TIMEOUT_MS: Record<string, number> = {
  generate: 600_000,
  compose: 900_000,
  "compose-remotion": 900_000,
  "compose-motion": 900_000,
  "compose-hyperframes": 900_000,
  "final-review": 120_000,
};

export interface MovieHostFnEntry {
  ns: "movie";
  name: string;
  fn: (args: unknown, ctx: MovieHostFnCtx) => Promise<unknown>;
  timeoutMs?: number;
}

/**
 * Parse dispatch's {ok,text} into a value: JSON if parseable, else the raw text.
 * Throw on error so workflow's call() surfaces a recoverable failure.
 */
function unwrap(res: { ok: true; text: string } | { ok: false; error: string }, name: string): unknown {
  if (!res.ok) throw new Error(`movie.${name}: ${res.error}`);
  try {
    return JSON.parse(res.text);
  } catch {
    return res.text;
  }
}

/** Build the movie.* host-fn registration entries (one per command + a dispatch escape hatch). */
export function buildMovieHostFnEntries(): MovieHostFnEntry[] {
  const entries: MovieHostFnEntry[] = COMMANDS.map((cmd) => ({
    ns: "movie",
    name: cmd,
    fn: async (args: unknown, _ctx: MovieHostFnCtx) => { markMovieActive(); return unwrap(await dispatch(cmd as Command, coerceOptions(args)), cmd); },
    timeoutMs: HOST_FN_TIMEOUT_MS[cmd],
  }));
  entries.push({
    ns: "movie",
    name: "dispatch",
    fn: async (args: unknown, _ctx: MovieHostFnCtx) => {
      markMovieActive();
      const a = coerceOptions(args);
      const cmd = String(a.command ?? "") as Command;
      return unwrap(await dispatch(cmd, coerceOptions(a.options)), "dispatch");
    },
  });
  return entries;
}

/**
 * The minimal shape workflow's call-global.ts reads: `hostFns.get(name)` →
 * `{fn, schema?, timeoutMs?}`. (HostFnRegistry is not in workflow's public
 * exports, so we duck-type — proven equivalent by the Phase-1 spike. No
 * workflow import needed, keeping src/ pi-SDK- and workflow-free.)
 */
export interface MovieHostFnRegistry {
  get(name: string): MovieHostFnEntry | undefined;
  has(name: string): boolean;
  list(): string[];
}

/** Build a duck-typed host-fn registry for `runWorkflow({ hostFns })`. */
export function buildMovieHostFnRegistry(): MovieHostFnRegistry {
  const entries = buildMovieHostFnEntries();
  const byName = new Map<string, MovieHostFnEntry>();
  for (const e of entries) byName.set(`${e.ns}.${e.name}`, e);
  return {
    get: (name: string) => byName.get(name),
    has: (name: string) => byName.has(name),
    list: () => [...byName.keys()].sort(),
  };
}
