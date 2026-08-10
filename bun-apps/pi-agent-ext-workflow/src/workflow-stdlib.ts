import type { TSchema } from "typebox";
import type { AgentFn, ParallelFn } from "./workflow.js";

export interface StdlibDeps {
  agent: AgentFn;
  parallel: ParallelFn;
}

export interface Stdlib {
  verify: (
    item: unknown,
    opts?: { reviewers?: number; threshold?: number; lens?: string | string[] },
  ) => Promise<{
    real: boolean;
    realCount: number;
    total: number;
    requested: number;
    failed: number;
    votes: Array<{ real?: boolean; reason?: string }>;
  }>;
  judgePanel: (
    attempts: unknown[],
    opts?: { judges?: number; rubric?: string },
  ) => Promise<{ index: number; attempt: unknown; score: number | undefined; judgments: unknown[] } | undefined>;
  loopUntilDry: (opts: {
    round: (i: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => Promise<unknown[] & { truncated?: true }>;
  completenessCheck: (taskArgs: unknown, results: unknown) => Promise<unknown>;
  retry: (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts?: { attempts?: number; until?: (r: unknown) => boolean },
  ) => Promise<unknown>;
  gate: (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts?: { attempts?: number },
  ) => Promise<{ ok: boolean; value: unknown; attempts: number }>;
}

/**
 * Fan out `count` agent() calls through `parallel`, labelling each
 * `${labelPrefix} ${i+1}` and forwarding one shared `schema`. Dedup target for
 * verify()/judgePanel(), which both spelled this `Array.from({length:n}, ...)` pattern inline.
 */
export async function parallelAgents(
  parallel: ParallelFn,
  agent: AgentFn,
  count: number,
  labelPrefix: string,
  promptBuilder: (i: number) => string,
  schema: TSchema,
): Promise<unknown[]> {
  return parallel(
    Array.from(
      { length: count },
      (_v, i) => () => agent(promptBuilder(i), { label: `${labelPrefix} ${i + 1}`, schema }),
    ),
  );
}

/**
 * Bounded `for i in attempts` loop. Calls `body(i)` until it returns `{ done: true }`
 * (returning that `value`) or `maxAttempts` is reached (returning the last `value`).
 * Dedup target for retry()/gate(), which both spelled this bounded-loop pattern inline.
 */
export async function attemptLoop(
  maxAttempts: number,
  body: (i: number) => Promise<{ done: boolean; value?: unknown }>,
): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const r = await body(i);
    last = r.value;
    if (r.done) return r.value;
  }
  return last;
}
