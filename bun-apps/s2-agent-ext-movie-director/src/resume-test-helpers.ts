/**
 * resume-test-helpers.ts — test-only helpers for the Layer A resume tests.
 *
 * Builds a duck-typed host-fn registry with a deterministic `test.step`
 * (counts live invocations so a test can prove the journal replayed the prefix)
 * + a never-invoked stub agent (the probe uses only call(), so no model is
 * needed). Mirrors the buildMovieHostFnRegistry {get,has,list} contract that
 * call-global reads.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProbeCounters {
  liveCalls: number;
  liveIds: number[];
}

export function buildProbeRegistry(c: ProbeCounters) {
  return {
    get: (name: string) =>
      name === "test.step"
        ? {
            fn: (args: { id: number }) => {
              c.liveCalls++;
              c.liveIds.push(args.id);
              return { id: args.id, ok: true };
            },
          }
        : undefined,
    has: (name: string) => name === "test.step",
    list: () => ["test.step"],
  };
}

/** The probe uses only call() — agent.run is never invoked. */
export const stubAgent = { run: async () => ({ text: "never-called" }) } as never;

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROBE_SCRIPT = readFileSync(join(HERE, "..", "workflows", "_resume-probe.js"), "utf8");

export function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "movie-resume-test-"));
}

/** Poll a persisted run until it reaches a terminal status (resume runs in the background). */
export async function waitForTerminal(
  load: () => { status?: string; result?: unknown } | null,
  iterations = 100,
  delayMs = 20,
): Promise<{ status?: string; result?: unknown } | null> {
  let state: { status?: string; result?: unknown } | null = null;
  for (let i = 0; i < iterations; i++) {
    state = load();
    if (state?.status === "completed" || state?.status === "failed" || state?.status === "aborted") break;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return state;
}
