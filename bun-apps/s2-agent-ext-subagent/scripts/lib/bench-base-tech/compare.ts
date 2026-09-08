/**
 * Scoring + comparison renderer (spec §8) — PURE functions, unit-gated.
 *
 * Pre-registered rubric: evidence-fidelity 0.30, robustness 0.30,
 * async-visibility 0.15, latency 0.15, simplicity 0.10.
 * Role rule: the production recommendation is drawn ONLY from rendered-truth
 * lanes; rpc gets a structured-complement verdict. Challenger needs >10%
 * margin over bun-terminal; ties keep the incumbent.
 */

export interface CaseOutcome {
  tech: string;
  case: string;
  pass: boolean | null; // null = unreachable (D8)
  ms?: number;
}

/** Fidelity on the lane's OWN terms (spec §8.2): byte-faithful render 1.0,
 *  tmux pane-scrape 0.8 (no byte lane, no DA handshake), rpc structured 1.0. */
export function fidelityFor(tech: string): number {
  if (tech === "tmux") return 0.8;
  return 1;
}

export interface TechInputs {
  tech: string;
  /** robustness-3x successes (0–3). */
  robustness: number;
  bootStable: boolean;
  /** subagent-dispatch evidence quality: 1 notification/structured, 0.5 marker-only, 0 fail/none. */
  asyncQuality: number;
  /** p50 trivial-ask ms + boot ms for the latency blend. */
  p50TrivialMs: number;
  bootMs: number;
  adapterLoc: number;
  externalParts: number; // moving parts beyond the driver: script(1)/tmux-server/none
}

export interface TechScore {
  tech: string;
  eligible: boolean;
  ineligibleReason?: string;
  scores: { fidelity: number; robustness: number; async: number; latency: number; simplicity: number };
  total: number; // 0–1
}

const W = { fidelity: 0.3, robustness: 0.3, async: 0.15, latency: 0.15, simplicity: 0.1 } as const;

export function scoreTech(t: TechInputs, bestLatencyMs: number): TechScore {
  if (t.robustness < 3 || !t.bootStable) {
    return {
      tech: t.tech,
      eligible: false,
      ineligibleReason: t.robustness < 3 ? `robustness ${t.robustness}/3` : "boot unstable",
      scores: { fidelity: 0, robustness: 0, async: 0, latency: 0, simplicity: 0 },
      total: 0,
    };
  }
  const latency = Math.min(1, bestLatencyMs / Math.max(1, 0.7 * t.p50TrivialMs + 0.3 * t.bootMs));
  const simplicity = 1 / (1 + t.externalParts * 0.15 + Math.max(0, t.adapterLoc - 120) / 400);
  const scores = {
    fidelity: fidelityFor(t.tech),
    robustness: 1, // eligibility already required 3/3 + stable boot
    async: Math.max(0, Math.min(1, t.asyncQuality)),
    latency,
    simplicity,
  };
  const total =
    W.fidelity * scores.fidelity +
    W.robustness * scores.robustness +
    W.async * scores.async +
    W.latency * scores.latency +
    W.simplicity * scores.simplicity;
  return { tech: t.tech, eligible: true, scores, total };
}

export interface Recommendation {
  productionLane: string;
  structuredComplement: string | null;
  reason: string;
}

export function recommend(scores: TechScore[]): Recommendation {
  const screen = scores.filter((s) => s.eligible && s.tech !== "rpc");
  const rpc = scores.find((s) => s.tech === "rpc" && s.eligible);
  if (screen.length === 0) {
    return {
      productionLane: rpc ? "rpc (fallback — no screen lane eligible)" : "none",
      structuredComplement: rpc ? "rpc" : null,
      reason: "no rendered-truth lane proved eligible",
    };
  }
  const incumbent = screen.find((s) => s.tech === "bun-terminal");
  const best = screen.reduce((a, b) => (b.total > a.total ? b : a));
  if (incumbent && best.tech !== "bun-terminal") {
    const margin = (best.total - incumbent.total) / incumbent.total;
    if (margin <= 0.1) {
      return {
        productionLane: "bun-terminal",
        structuredComplement: rpc ? "rpc" : null,
        reason: `challenger ${best.tech} margin ${(margin * 100).toFixed(1)}% ≤ 10% — incumbent keeps the seat`,
      };
    }
    return {
      productionLane: best.tech,
      structuredComplement: rpc ? "rpc" : null,
      reason: `${best.tech} beats bun-terminal by ${(margin * 100).toFixed(1)}% (>10%)`,
    };
  }
  return {
    productionLane: "bun-terminal",
    structuredComplement: rpc ? "rpc" : null,
    reason: incumbent
      ? "incumbent bun-terminal leads (or ties) among eligible rendered-truth lanes"
      : `bun-terminal ineligible; best screen lane ${best.tech}`,
  };
}

export function renderComparisonMd(
  rows: Array<{
    tech: string;
    renderedTruth: boolean;
    dialogs: string;
    asyncEvents: string;
    deps: string;
    loc: number;
  }>,
  scores: TechScore[],
  cases: Array<CaseOutcome>,
  rec: Recommendation,
): string {
  const techs = [...new Set(cases.map((c) => c.tech))];
  const lines: string[] = [];
  lines.push("# Base-tech benchmark comparison (self-arc-13)", "");
  lines.push("## Per-case outcomes", "");
  lines.push(`| case | ${techs.join(" | ")} |`);
  lines.push(`|---|${techs.map(() => "---").join("|")}`);
  for (const cid of [...new Set(cases.map((c) => c.case))]) {
    const cells = techs.map((tech) => {
      const o = cases.find((c) => c.case === cid && c.tech === tech);
      if (!o) return "—";
      if (o.pass === null) return "N/A";
      return o.pass ? `✅${o.ms != null ? ` ${o.ms}ms` : ""}` : "❌";
    });
    lines.push(`| ${cid} | ${cells.join(" | ")} |`);
  }
  lines.push("", "## Scores (eligible lanes only)", "");
  lines.push("| tech | total | fidelity | robustness | async | latency | simplicity |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of scores) {
    if (!s.eligible) {
      lines.push(`| ${s.tech} | INELIGIBLE (${s.ineligibleReason}) | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${s.tech} | ${s.total.toFixed(3)} | ${s.scores.fidelity.toFixed(2)} | ${s.scores.robustness.toFixed(2)} | ${s.scores.async.toFixed(2)} | ${s.scores.latency.toFixed(2)} | ${s.scores.simplicity.toFixed(2)} |`,
    );
  }
  lines.push("", "## Capability matrix", "");
  lines.push("| tech | rendered truth | dialogs | async events | external deps | adapter LOC |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows)
    lines.push(
      `| ${r.tech} | ${r.renderedTruth ? "yes" : "no (structured)"} | ${r.dialogs} | ${r.asyncEvents} | ${r.deps} | ${r.loc} |`,
    );
  lines.push(
    "",
    "## Recommendation",
    "",
    `- **Production lane: ${rec.productionLane}**`,
    `- Structured complement: ${rec.structuredComplement ?? "none"}`,
    `- ${rec.reason}`,
    "",
  );
  return lines.join("\n");
}
