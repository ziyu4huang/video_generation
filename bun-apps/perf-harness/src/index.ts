/**
 * perf-harness — shared measurement primitives for cross-extension agent tool
 * schema-cost and latency benchmarking.
 *
 * Token estimate: chars / 4 (matches the existing `measure-schema-tokens.mjs`
 * convention in s2-agent-ext-obsidian/scripts/). Sufficient for regression
 * detection without adding a tokenizer dependency.
 */

/** A captured tool shape — enough to estimate schema cost. */
export interface ToolLike {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  [key: string]: unknown;
}

/**
 * Create a fake-pi that captures `registerTool` calls into `tools`.
 * All other pi methods (registerCommand, on, …) are swallowed by the Proxy
 * so any extension factory can run without real infrastructure. `pi.events`
 * is provided for extensions (knowledge-card) that register host-fns.
 */
export function createCapturePi(): { pi: any; tools: Record<string, ToolLike> } {
  const tools: Record<string, ToolLike> = {};
  const target = {
    registerTool: (t: ToolLike) => {
      if (t?.name) tools[t.name] = t;
    },
    events: {
      emit: () => {},
      on: () => {},
    },
  };
  const pi = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return (t as any)[prop];
      return () => {};
    },
  });
  return { pi, tools };
}

/** Convenience: run a factory through a capture-pi and return the tools. */
export function captureTools(factory: (pi: any) => void): Record<string, ToolLike> {
  const { pi, tools } = createCapturePi();
  factory(pi);
  return tools;
}

/** Estimate one tool's schema token cost. */
export function estimateSchemaTokens(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): { chars: number; tokens: number } {
  const json = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  return { chars: json.length, tokens: Math.round(json.length / 4) };
}

/** Estimate total schema cost for a tool set, with per-tool breakdown (desc). */
export function estimateTotalSchemaTokens(tools: Record<string, ToolLike>): {
  perTool: Array<{ name: string; chars: number; tokens: number }>;
  total: { chars: number; tokens: number };
} {
  const perTool = Object.values(tools)
    .map((t) => {
      const { chars, tokens } = estimateSchemaTokens(t);
      return { name: t.name, chars, tokens };
    })
    .sort((a, b) => b.tokens - a.tokens);
  const total = perTool.reduce(
    (acc, t) => ({ chars: acc.chars + t.chars, tokens: acc.tokens + t.tokens }),
    { chars: 0, tokens: 0 },
  );
  return { perTool, total };
}

/** Budget metadata for an auditable regression assertion. */
export interface Budget {
  max: number;
  baseline: number;
  measuredAt: string;
  commit: string;
  label: string;
}

/**
 * Assert `actual ≤ budget.max`. On failure, throw with an auditable message
 * showing the baseline, measurement date, and commit so the developer knows
 * where the threshold came from and what to update.
 */
export function assertWithinBudget(actual: number, budget: Budget): void {
  if (actual <= budget.max) return;
  throw new Error(
    `${budget.label}: ${actual} tokens exceeds budget ${budget.max} ` +
      `(baseline ${budget.baseline} at ${budget.commit}, measured ${budget.measuredAt}). ` +
      `If this growth is intentional, update the budget constant with a fresh measurement.`,
  );
}

/** Latency measurement result. */
export interface LatencyResult {
  label: string;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/**
 * Measure latency of an async fn: warmup runs (discarded) + N timed runs.
 * Returns p50/p95/min/max in milliseconds. Designed for deterministic
 * (pure-CPU) paths where percentiles are stable.
 */
export async function benchLatency<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { runs?: number; warmup?: number },
): Promise<LatencyResult> {
  const runs = opts?.runs ?? 20;
  const warmup = opts?.warmup ?? 1;
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number) => samples[Math.min(Math.floor(samples.length * p), samples.length - 1)];
  return {
    label,
    p50: pct(0.5),
    p95: pct(0.95),
    min: samples[0],
    max: samples[samples.length - 1],
  };
}
