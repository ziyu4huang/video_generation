/**
 * Comparison-v2 renderer (self-arc-15 t02) — the complex-suite dimension
 * table. PURE functions, unit-gated. No composite score by design (map D3
 * descoped it): the dimension table + materiality verdict carries the
 * evidence, with the base-suite reference row citing arc-13's numbers.
 */
import type { CaseReceipt } from "./types.js";

export interface DimensionRow {
  dimension: string;
  case: string;
  bunTerminal: string;
  rpc: string;
}

function cell(r: CaseReceipt | undefined): string {
  if (!r) return "—";
  if (r.pass === null) return "N/A";
  return r.pass ? "✅" : "❌";
}

function ms(r: CaseReceipt | undefined, key: string): string {
  const v = r?.timingsMs?.[key];
  return typeof v === "number" ? ` ${(v / 1000).toFixed(1)}s` : "";
}

export function dimensionRows(receipts: CaseReceipt[]): DimensionRow[] {
  const bt = (c: string) => receipts.find((r) => r.tech === "bun-terminal" && r.case === c);
  const rp = (c: string) => receipts.find((r) => r.tech === "rpc" && r.case === c);
  const rows: DimensionRow[] = [];

  const mtBt = bt("cx-multi-turn");
  const mtRp = rp("cx-multi-turn");
  rows.push({
    dimension: "continuity (turn-3 recall)",
    case: "cx-multi-turn",
    bunTerminal: `${cell(mtBt)}${ms(mtBt, "step2-submit")}`,
    rpc: `${cell(mtRp)}${ms(mtRp, "step2-submit")}`,
  });

  const abBt = bt("cx-midturn-abort");
  const abRp = rp("cx-midturn-abort");
  const abortVis = (r?: CaseReceipt) => {
    if (!r) return "—";
    const ok = r.evidence.stepFlags as Record<string, boolean> | undefined;
    if (r.tech === "rpc") return `${cell(r)}${ok?.abortResponseOk ? " · protocol-ack" : " · NO-ack"}`;
    return cell(r);
  };
  rows.push({
    dimension: "mid-flight control (abort→quiet→recover)",
    case: "cx-midturn-abort",
    bunTerminal: abortVis(abBt),
    rpc: abortVis(abRp),
  });

  const loBt = bt("cx-long-output");
  const loRp = rp("cx-long-output");
  const fidelity = (r?: CaseReceipt) => {
    if (!r) return "—";
    const lines = Number(r.evidence.linesSeen ?? 0);
    const bytes = Number(r.evidence.bytesReceived ?? 0);
    return `${cell(r)} · ${lines}/20 lines · ${bytes}B`;
  };
  rows.push({
    dimension: "long-output fidelity (cumulative latch vs full text)",
    case: "cx-long-output",
    bunTerminal: fidelity(loBt),
    rpc: fidelity(loRp),
  });

  const epBt = bt("cx-error-path");
  const epRp = rp("cx-error-path");
  rows.push({
    dimension: "error visibility (failing bash surfaces)",
    case: "cx-error-path",
    bunTerminal: `${cell(epBt)}${ms(epBt, "step0-submit")}`,
    rpc: `${cell(epRp)}${ms(epRp, "step0-submit")}`,
  });
  return rows;
}

export function renderComparisonV2(receipts: CaseReceipt[]): string {
  const lines: string[] = [];
  lines.push("# Base-tech benchmark v2 — complex variants (self-arc-15)", "");
  lines.push("Lanes: bun-terminal × rpc (arc-13 earned them; bun-pty N/A by arbitration, tmux lost).");
  lines.push("Deployed-only; per-case receipts under output/ (scratch).", "");
  lines.push("## Dimension table", "");
  lines.push("| dimension | case | bun-terminal | rpc |");
  lines.push("|---|---|---|---|");
  for (const r of dimensionRows(receipts)) {
    lines.push(`| ${r.dimension} | ${r.case} | ${r.bunTerminal} | ${r.rpc} |`);
  }
  const fails = receipts.filter((r) => r.pass === false);
  lines.push("", "## Per-case verdicts", "");
  for (const r of receipts) {
    lines.push(`- ${r.tech} · ${r.case}: ${r.verdict}${r.notes.length ? ` — ${r.notes.join("; ")}` : ""}`);
  }
  lines.push(
    "",
    "## Base-suite reference (arc-13, committed)",
    "",
    "- bun-terminal 0.834 (production seat) · rpc 0.847 (structured complement) — `.planning/2026-09-06-self-arc-13/results/comparison.md`",
    `- This matrix: ${receipts.length - fails.length}/${receipts.length} green${fails.length ? ` · ${fails.length} red` : ""}.`,
    "",
  );
  return lines.join("\n");
}
