/**
 * Runnable entry for the `.planning/` finished-ness audit — a thin argv-in /
 * JSON-out wrapper over `src/effort-audit.ts` (same shape as
 * sweep-zero-citation.ts). Supplies the git-backed `verifyPr`
 * (`git log --grep "#N"` resolves merged squash commits offline) and can write
 * the JSON report + a markdown table via `--out <dir>`.
 *
 *   bun scripts/effort-audit.ts                          # audit to stdout, git-verified citations
 *   bun scripts/effort-audit.ts --out <dir>              # also write <dir>/audit.{json,md}
 *   bun scripts/effort-audit.ts --stale-days 30          # widen the staleness threshold
 *   bun scripts/effort-audit.ts --no-verify              # skip PR verification (no git)
 *   bun scripts/effort-audit.ts --exempt <slug>          # extra live-exempt slug (repeatable)
 *
 * JSON on stdout, diagnostics on stderr. Exit 0 = no red findings · 1 = reds
 * present (or run failure) · 2 usage error. Reds are the point — a baseline
 * run on an unreconciled tree is EXPECTED to exit 1; capture it as evidence.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AuditReport, auditEfforts } from "../src/effort-audit.js";

function usage(): number {
  console.error(
    "usage: effort-audit.ts [--root <path>] [--stale-days <n>] [--out <dir>] [--no-verify] [--exempt <slug>]...\n" +
      "  walks .planning/2026-* effort dirs; red = missing/unknown status, stale\n" +
      "  non-terminal without a dated park note, terminal without Shipped-as/Resolution,\n" +
      "  or a cited PR that git log cannot resolve as merged. Exit 1 when any red.",
  );
  return 2;
}

interface Opts {
  root: string;
  staleDays: number;
  out: string | null;
  verify: boolean;
  exempt: string[];
}

function arg(argv: string[]): Opts {
  const opts: Opts = { root: process.cwd(), staleDays: 14, out: null, verify: true, exempt: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") throw { usage: true };
    if (a === "--root") {
      opts.root = argv[++i] ?? "";
      if (!opts.root) throw { usage: true };
    } else if (a === "--stale-days") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw { usage: true };
      opts.staleDays = Math.floor(n);
    } else if (a === "--out") {
      opts.out = argv[++i] ?? "";
      if (!opts.out) throw { usage: true };
    } else if (a === "--no-verify") {
      opts.verify = false;
    } else if (a === "--exempt") {
      const slug = argv[++i] ?? "";
      if (!slug) throw { usage: true };
      opts.exempt.push(slug);
    } else {
      throw { usage: true };
    }
  }
  return opts;
}

/** git-backed citation check: `git log --grep "#N"` (offline; squash commits
 *  carry "(#N)" in the title). Any commit message naming the PR counts. */
function gitVerifyPr(root: string): (pr: number) => boolean {
  return (pr: number) => {
    const r = Bun.spawnSync(["git", "-C", root, "log", "--grep", `#${pr}`, "--oneline", "-1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.exitCode === 0 && r.stdout.toString().trim().length > 0;
  };
}

function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# .planning/ effort audit — ${report.generatedAt}`, "");
  lines.push(
    `- root: \`${report.root}\` · scanned: ${report.scanned} · stale-days: ${report.staleDays} · **red: ${report.redCount}**`,
  );
  lines.push(
    `- census: ${Object.entries(report.census)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  if (report.duplicateArcRounds.length > 0) {
    lines.push("", "## Duplicate self-arc rounds (info — by-design parallel sessions)", "");
    for (const d of report.duplicateArcRounds) lines.push(`- round ${d.round}: ${d.efforts.join(" · ")}`);
  }
  lines.push("", "## Findings", "", "| effort | status | last | findings |", "|---|---|---|---|");
  for (const rec of report.records) {
    const cell =
      rec.findings.length === 0
        ? "green"
        : rec.findings
            .map((f) => `${f.severity}:${f.code}${f.severity === "red" ? ` — ${f.message}` : ""}`)
            .join("<br>");
    lines.push(`| ${rec.effort} | ${rec.statusToken ?? "·"} | ${rec.last ?? "·"} | ${cell} |`);
  }
  if (report.errors.length > 0) {
    lines.push("", "## Read errors", "");
    for (const e of report.errors) lines.push(`- ${e.dir}: ${e.error}`);
  }
  lines.push("");
  return lines.join("\n");
}

function main(argv: string[]): number {
  let opts: Opts;
  try {
    opts = arg(argv);
  } catch (e) {
    if ((e as { usage?: boolean }).usage) return usage();
    return 2;
  }
  opts.root = resolve(opts.root);
  for (const slug of opts.exempt) {
    // Scoped to this run only — the hardcoded dated list stays in src.
    const { LIVE_EXEMPT } = require("../src/effort-audit.js") as typeof import("../src/effort-audit.js");
    LIVE_EXEMPT.add(slug);
  }

  try {
    const report = auditEfforts(opts.root, {
      staleDays: opts.staleDays,
      verifyPr: opts.verify ? gitVerifyPr(opts.root) : null,
    });
    console.log(JSON.stringify(report, null, 2));
    if (opts.out) {
      const outDir = resolve(opts.out);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, "audit.json"), `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(resolve(outDir, "audit.md"), renderMarkdown(report));
    }
    console.error(
      `[effort-audit] scanned ${report.scanned}; red ${report.redCount}; info ${report.records.reduce((n, r) => n + r.findings.filter((f) => f.severity === "info").length, 0)}; duplicate-arc rounds ${report.duplicateArcRounds.length}.`,
    );
    return report.redCount > 0 ? 1 : 0;
  } catch (err) {
    console.error(`effort-audit failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
