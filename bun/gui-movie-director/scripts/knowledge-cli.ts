#!/usr/bin/env bun
/**
 * T2I Knowledge CLI
 *
 * Usage (from bun/gui-movie-director/):
 *   bun run knowledge:scan [--json] [--min-score N]
 *   bun run knowledge:extract [--dry-run] [--limit N]
 *   bun run knowledge:learn [--output path.md] [--min-score N] [--max-records N]
 */

import {
  scanOutputDirs,
  generateMissingCaptions,
  callDeepSeek,
  saveReport,
} from "../lib/knowledge-extractor";
import fs from "fs";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else if (!out["_subcommand"]) {
      out["_subcommand"] = a;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const subcommand = args["_subcommand"] as string | undefined;

function printHelp() {
  console.log(`
T2I Knowledge CLI

Commands:
  scan              Scan output folders and list T2I records
  extract-captions  Generate review captions for images that are missing them
  learn             Call DeepSeek to extract prompt engineering knowledge

Options:
  --json            Output JSON instead of table (scan)
  --min-score N     Only include records with overall score >= N (default: 0)
  --dry-run         List images that need captions, don't generate (extract-captions)
  --limit N         Process at most N images (extract-captions)
  --max-records N   Send at most N records to DeepSeek (learn, default: 60)
  --output path     Save Markdown report to file (learn)
`);
}

async function cmdScan() {
  const records = scanOutputDirs();
  const minScore = args["min-score"] ? parseFloat(args["min-score"] as string) : 0;
  const filtered = minScore > 0 ? records.filter((r) => (r.qualityScore ?? 0) >= minScore) : records;

  if (args["json"]) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const withCaption = filtered.filter((r) => r.hasCaption).length;
  const avgScore = withCaption > 0
    ? (filtered.reduce((s, r) => s + (r.qualityScore ?? 0), 0) / withCaption).toFixed(1)
    : "—";

  console.log(`\nT2I Records: ${filtered.length}  |  With caption: ${withCaption}  |  Missing: ${filtered.length - withCaption}  |  Avg score: ${avgScore}\n`);
  console.log(["Stem".padEnd(35), "Pipeline".padEnd(14), "Score".padEnd(7), "Cap?".padEnd(6), "LoRA"].join(""));
  console.log("─".repeat(90));
  for (const r of filtered) {
    const loraName = r.run?.lora_path ? r.run.lora_path.split("/").pop()?.slice(0, 20) ?? "—" : "—";
    console.log([
      r.stem.padEnd(35),
      r.pipeline.padEnd(14),
      (r.qualityScore?.toString() ?? "—").padEnd(7),
      (r.hasCaption ? "✓" : "✗").padEnd(6),
      loraName,
    ].join(""));
  }
}

async function cmdExtract() {
  const records = scanOutputDirs();
  const missing = records.filter((r) => !r.hasCaption);
  const limit = args["limit"] ? parseInt(args["limit"] as string, 10) : undefined;
  const batch = limit ? missing.slice(0, limit) : missing;

  if (batch.length === 0) {
    console.log("✓ No missing captions — all records are complete.");
    return;
  }

  if (args["dry-run"]) {
    console.log(`Would generate captions for ${batch.length} images:\n`);
    for (const r of batch) console.log(`  ${r.stem}  (${r.pipeline})`);
    return;
  }

  console.log(`Generating captions for ${batch.length} images…\n`);
  const { generated, failed } = await generateMissingCaptions(
    records,
    (p) => {
      if (p.current) process.stdout.write(`  [${p.done + 1}/${p.total}] ${p.current}\n`);
    },
    limit,
  );
  console.log(`\nDone: ${generated} generated, ${failed} failed.`);
}

async function cmdLearn() {
  const records = scanOutputDirs();
  const minScore = args["min-score"] ? parseFloat(args["min-score"] as string) : 0;
  const maxRecords = args["max-records"] ? parseInt(args["max-records"] as string, 10) : 60;
  const outputPath = args["output"] as string | undefined;

  console.log(`Sending records to DeepSeek (min score: ${minScore}, max: ${maxRecords})…`);

  let report;
  try {
    report = await callDeepSeek(records, { minScore, maxRecords });
  } catch (err: any) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }

  saveReport(report);
  console.log(`\n✓ Report saved (${report.recordCount} records, avg score ${report.avgQualityScore})`);

  if (outputPath) {
    fs.writeFileSync(outputPath, report.markdown, "utf-8");
    console.log(`✓ Markdown saved to: ${outputPath}`);
  } else {
    console.log("\n--- Markdown Guide ---\n");
    console.log(report.markdown);
  }
}

switch (subcommand) {
  case "scan":
    await cmdScan();
    break;
  case "extract-captions":
    await cmdExtract();
    break;
  case "learn":
    await cmdLearn();
    break;
  default:
    printHelp();
    if (subcommand) {
      console.error(`Unknown command: ${subcommand}`);
      process.exit(1);
    }
}
