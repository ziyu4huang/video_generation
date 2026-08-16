import { WorkflowErrorCode } from "@repo/pi-agent-core-runtime";
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
 * `labelBuilder(i)` and forwarding one shared `schema`. Dedup target for
 * verify()/judgePanel(), which both spelled this `Array.from({length:n}, ...)` pattern inline.
 */
export async function parallelAgents(
  parallel: ParallelFn,
  agent: AgentFn,
  count: number,
  labelBuilder: (i: number) => string,
  promptBuilder: (i: number) => string,
  schema: TSchema,
): Promise<unknown[]> {
  return parallel(
    Array.from({ length: count }, (_v, i) => () => agent(promptBuilder(i), { label: labelBuilder(i), schema })),
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

const VERIFY_SCHEMA = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real"],
};
const JUDGE_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" }, reason: { type: "string" } },
  required: ["score"],
};
const COMPLETENESS_SCHEMA = {
  type: "object",
  properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
  required: ["complete"],
};

export function createStdlib(deps: StdlibDeps): Stdlib {
  const { agent, parallel } = deps;

  const verify: Stdlib["verify"] = async (item, opts = {}) => {
    const reviewers = Math.max(1, opts.reviewers ?? 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : JSON.stringify(item);
    const votes = (
      await parallelAgents(
        parallel,
        agent,
        reviewers,
        (i) => `verify ${i + 1}`,
        (i) =>
          `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
        VERIFY_SCHEMA as unknown as TSchema,
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    return {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      requested: reviewers,
      failed: reviewers - votes.length,
      votes,
    };
  };

  const judgePanel: Stdlib["judgePanel"] = async (attempts, opts = {}) => {
    const judges = Math.max(1, opts.judges ?? 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : JSON.stringify(att);
          const js = (
            await parallelAgents(
              parallel,
              agent,
              judges,
              (j) => `judge ${idx + 1}.${j + 1}`,
              () => `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
              JUDGE_SCHEMA as unknown as TSchema,
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : undefined;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number | undefined; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index. A candidate whose
    // judges ALL failed has score === undefined (unscored) — do not rank it above
    // any scored candidate (RCA#7). When every candidate is unscored, return the first.
    let best: (typeof scored)[0] | undefined;
    let bestScore: number | undefined;
    let bestIndex: number | undefined;
    for (const s of scored) {
      if (s.score === undefined) continue;
      if (
        bestScore === undefined ||
        s.score > bestScore ||
        (s.score === bestScore && s.index < (bestIndex ?? Infinity))
      ) {
        best = s;
        bestScore = s.score;
        bestIndex = s.index;
      }
    }
    best ??= scored[0];
    return best;
  };

  const loopUntilDry: Stdlib["loopUntilDry"] = async (opts) => {
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
    const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
    const maxRounds = opts.maxRounds ?? 50;
    const seen = new Set<string>();
    const all: unknown[] = [];
    let truncated = false;
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result as
        // truncated, not as a completed dry run (RCA#8).
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) {
          truncated = true;
          break;
        }
        throw error;
      }
      const fresh = (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    // Attach a truncated flag to the result array so callers can distinguish
    // "completed all rounds dry" from "truncated by budget/limit" (RCA#8).
    const result = all.slice();
    if (truncated) (result as any).truncated = true;
    return result;
  };

  const completenessCheck: Stdlib["completenessCheck"] = (taskArgs, results) =>
    agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA as unknown as TSchema },
    );

  const retry: Stdlib["retry"] = async (thunk, opts = {}) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    return attemptLoop(attempts, async (i) => {
      const last = await thunk(i);
      return { done: !opts.until || opts.until(last), value: last };
    });
  };

  const gate: Stdlib["gate"] = async (thunk, validator, opts = {}) => {
    const attempts = Math.max(1, opts.attempts ?? 3);
    let feedback: string | undefined;
    const out = await attemptLoop(attempts, async (i) => {
      const last = await thunk(feedback, i);
      const verdict = await validator(last);
      if (verdict?.ok) return { done: true, value: { ok: true, value: last, attempts: i + 1 } };
      feedback = verdict?.feedback;
      return { done: false, value: { ok: false, value: last, attempts: i + 1 } };
    });
    return out as { ok: boolean; value: unknown; attempts: number };
  };

  return { verify, judgePanel, loopUntilDry, completenessCheck, retry, gate };
}
