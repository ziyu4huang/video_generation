/**
 * Run video collection for all platforms and output to study-news vault.
 *
 * Usage:
 *   bun run bun-apps/s2-agent-ext-research-tool/run-video-collection.ts
 *
 * Set YOUTUBE_API_KEY in the environment for YouTube collection.
 * Pass --proxy http://127.0.0.1:7890 for Bilibili if behind 412.
 */

import { resolveKeywords, filterRelevant } from "./lib/filter.ts";
import {
  fetchBuvid3,
  searchVideos,
  fetchHotVideos,
  sleep,
} from "./lib/bilibili.ts";
import { searchYtKeyword, publishedAfterDays } from "./lib/youtube.ts";
import { generateMarkdown, weeklyFilename } from "./lib/format.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { VideoResult, KeywordGroup, CollectionResult } from "./lib/types.ts";

// ── Config ──────────────────────────────────────────────────────────
const OUTPUT_DIR = resolve("vaults_root/study-news/weekly-news");
const proxy = undefined; // set to "http://127.0.0.1:7890" if needed
const pages = 1;

type Platform = "bilibili" | "youtube";
type Preset = "llm" | "media" | "custom";

interface RunSpec {
  platform: Platform;
  preset: Preset;
  popular?: boolean;
}

const RUNS: RunSpec[] = [
  { platform: "bilibili", preset: "llm", popular: false },
  { platform: "bilibili", preset: "media", popular: false },
  { platform: "youtube", preset: "llm", popular: false },
];

// ── Helpers ─────────────────────────────────────────────────────────

async function collectBilibili(
  preset: Preset,
  opts: { pages: number; popular: boolean; proxy?: string },
): Promise<CollectionResult> {
  const keywords = resolveKeywords(preset, undefined, "bilibili");
  const buvid3 = await fetchBuvid3(opts.proxy);
  const cookieStr = `buvid3=${buvid3};`;

  let hot: VideoResult[] | undefined;
  if (opts.popular) {
    const hotAll = await fetchHotVideos(1, 50, cookieStr, opts.proxy);
    hot = filterRelevant(hotAll, preset);
    console.log(`  popular: ${hot.length} relevant of ${hotAll.length}`);
  }

  const groups: KeywordGroup[] = [];
  for (const keyword of keywords) {
    const all: VideoResult[] = [];
    for (let p = 1; p <= opts.pages; p++) {
      const videos = await searchVideos(keyword, {
        order: "click",
        page: p,
        cookieStr,
        proxy: opts.proxy,
      });
      if (videos.length === 0) break;
      all.push(...videos);
      if (p < opts.pages) await sleep(1500);
    }
    groups.push({ keyword, videos: all });
    console.log(`  "${keyword}": ${all.length} videos`);
  }

  return {
    platform: "bilibili",
    preset,
    groups,
    hot,
    dateStr: new Date().toISOString().split("T")[0] ?? "",
  };
}

async function collectYoutube(
  preset: Preset,
  opts: { pages: number; recency: number },
): Promise<CollectionResult> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "YOUTUBE_API_KEY not set. Set it: export YOUTUBE_API_KEY='...'",
    );
  }

  const keywords = resolveKeywords(preset, undefined, "youtube");
  const publishedAfter = publishedAfterDays(opts.recency);

  const groups: KeywordGroup[] = [];
  for (const keyword of keywords) {
    const videos = await searchYtKeyword(keyword, apiKey, {
      order: "relevance",
      pages: opts.pages,
      publishedAfter,
    });
    groups.push({ keyword, videos });
    console.log(`  "${keyword}": ${videos.length} videos`);
  }

  return {
    platform: "youtube",
    preset,
    groups,
    dateStr: new Date().toISOString().split("T")[0] ?? "",
  };
}

async function writeResult(
  result: CollectionResult,
  outputDir: string,
): Promise<string> {
  const markdown = generateMarkdown(result);
  const filename = weeklyFilename(result.platform, result.preset);
  const writePath = join(outputDir, filename);
  await mkdir(dirname(writePath), { recursive: true });
  await writeFile(writePath, markdown, "utf-8");
  return writePath;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  for (const run of RUNS) {
    console.log(`\n=== Collecting ${run.platform} / ${run.preset} ===`);

    try {
      let result: CollectionResult;

      if (run.platform === "bilibili") {
        result = await collectBilibili(run.preset as Preset, {
          pages: run.platform === "bilibili" ? pages : pages,
          popular: run.popular ?? false,
          proxy,
        });
      } else {
        result = await collectYoutube(run.preset as Preset, {
          pages,
          recency: 30,
        });
      }

      const path = await writeResult(result, OUTPUT_DIR);
      const total = result.groups.reduce(
        (s, g) => s + g.videos.length,
        0,
      );
      console.log(`  ✓ Written to: ${path} (${total} videos)`);
    } catch (err) {
      console.error(`  ✗ ERROR: ${(err as Error).message}`);
    }
  }

  console.log("\n=== All done ===");
}

main().catch(console.error);
