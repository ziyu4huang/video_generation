/**
 * Runnable entry for the `.planning/` zero-citation sweeper — a thin argv-in /
 * JSON-out wrapper over `src/sweep-zero-citation.ts`. Default (no flag) is a
 * READ-ONLY dry-run report; `--archive` performs the (mutating) relocation of
 * zero-citation COMPLETE efforts into `.planning/archive/`.
 *
 *   bun scripts/sweep-zero-citation.ts                # dry-run report (no mutation)
 *   bun scripts/sweep-zero-citation.ts --archive      # move zero-citation complete efforts to .planning/archive/
 *   bun scripts/sweep-zero-citation.ts --root <path>  # override the repo root (default: cwd)
 *
 * JSON on stdout, diagnostics on stderr. Exit 0 success · 1 failure ·
 * 2 usage error. Destructive (--archive) is deliberate and opt-in; run the
 * dry-run report first and review `zeroCitationComplete` before archiving.
 */

import { resolve } from "node:path";
import { archiveZeroCitationEfforts, classifyZeroCitationEfforts } from "../src/sweep-zero-citation.js";

function usage(): number {
  console.error(
    "usage: sweep-zero-citation.ts [--root <path>] [--archive]\n" +
      "  (default) read-only dry-run report over .planning/ root + done/ efforts\n" +
      "  --archive  move zero-citation COMPLETE efforts into .planning/archive/ (destructive, opt-in)",
  );
  return 2;
}

function arg(argv: string[]): { root: string; archive: boolean } {
  let root = process.cwd();
  let archive = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") throw { usage: true };
    if (a === "--root") {
      root = argv[++i] ?? "";
      if (!root) throw { usage: true };
    } else if (a === "--archive") {
      archive = true;
    }
  }
  return { root: resolve(root), archive };
}

function main(argv: string[]): number {
  let opts: { root: string; archive: boolean };
  try {
    opts = arg(argv);
  } catch (e) {
    if ((e as { usage?: boolean }).usage) return usage();
    return 2;
  }

  try {
    if (opts.archive) {
      const r = archiveZeroCitationEfforts(opts.root);
      console.log(JSON.stringify({ dryRun: false, moved: r.moved, skipped: r.skipped }, null, 2));
      return 0;
    }
    const report = classifyZeroCitationEfforts(opts.root);
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          scanned: report.scanned,
          zeroCitationComplete: report.zeroCitationComplete,
          zeroCitationGuarded: report.zeroCitationGuarded,
          cited: report.cited,
          errors: report.errors,
        },
        null,
        2,
      ),
    );
    console.error(
      `[sweep-zero-citation] scanned ${report.scanned}; zero-citation complete: ${report.zeroCitationComplete.length} (archive-able), guarded: ${report.zeroCitationGuarded.length}, cited: ${report.cited}. Dry-run only — re-run with --archive to move.`,
    );
    return 0;
  } catch (err) {
    console.error(`sweep-zero-citation failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
