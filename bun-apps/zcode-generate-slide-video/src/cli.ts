#!/usr/bin/env bun
/**
 * zcode-generate-slide-video — render an HTML slide deck into a narrated MP4.
 *
 * Pipeline: discover slides → narrate each (say or mlx-audio → wav) → capture
 * each slide as a live animation via CDP screencast (composed slides stagger
 * their blocks in; diagram slides draw nodes then edges in flow order —
 * synchronized build-ins, not pan/zoom) → build per-slide segments timed to
 * the audio → concat with crossfades → global fade in/out. --static falls back
 * to still frames. Zero npm deps; drives Chrome, say/mlx-audio, ffmpeg.
 *
 * Run from the repo root:
 *   bun bun-apps/zcode-generate-slide-video/src/cli.ts --deck output/slides-deck --tts mlx
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { buildSegment, buildSegmentFromFrames, concatSegments } from "./lib/assemble.ts";
import { INJECT_BLOCK } from "./lib/animate.ts";
import { captureAnimated } from "./lib/capture.ts";
import { HELP, parseArgs, toConfig, type NarrationFile, type VideoConfig } from "./lib/config.ts";
import { cleanup, detectChrome, requireTool, screenshotSlide } from "./lib/frames.ts";
import { deriveNarration, matchSlides } from "./lib/narration.ts";
import { probeDuration, synthLine } from "./lib/tts.ts";

const SLIDE_FILE = /^slide-\d+\.html$/;

function bySlideNumber(a: string, b: string): number {
  const na = Number(a.match(/\d+/)?.[0] ?? 0);
  const nb = Number(b.match(/\d+/)?.[0] ?? 0);
  return na - nb;
}

function discoverSlidesDir(deckDir: string, explicit?: string): string {
  if (explicit) {
    const dir = join(deckDir, explicit);
    if (!existsSync(dir)) throw new Error(`--slides-dir not found: ${dir}`);
    return dir;
  }
  const found = readdirSync(deckDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(".slides"))
    .map((e) => e.name)
    .sort();
  if (found.length === 0) throw new Error(`no *.slides/ dir inside ${deckDir}`);
  if (found.length > 1) {
    throw new Error(`multiple *.slides/ dirs in ${deckDir}: ${found.join(", ")} — pass --slides-dir`);
  }
  return join(deckDir, found[0]!);
}

/** Narration source: --narration file > <deckDir>/narration.json > derived from deck.config.json. */
async function loadNarration(cfg: VideoConfig, files: string[]): Promise<NarrationFile> {
  const narrationPath = cfg.narrationFile ?? join(cfg.deckDir, "narration.json");
  if (existsSync(narrationPath)) {
    const parsed = JSON.parse(await Bun.file(narrationPath).text()) as NarrationFile;
    if (!Array.isArray(parsed.slides) || parsed.slides.length === 0) {
      throw new Error(`${narrationPath} has no slides[]`);
    }
    return parsed;
  }
  const manifestPath = join(cfg.deckDir, "deck.config.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `no narration.json and no deck.config.json in ${cfg.deckDir} — ` +
        "write a narration.json (see --help) so the video has a script",
    );
  }
  console.log("no narration.json — deriving narration from deck.config.json");
  return deriveNarration(JSON.parse(await Bun.file(manifestPath).text()));
}

/**
 * Pipeline: discover slides → narrate each (say or mlx-audio → wav) → capture
 * each slide as a live animation via CDP screencast (composed slides stagger
 * their blocks in; diagram slides draw nodes then edges in flow order —
 * synchronized build-ins, not pan/zoom) → build per-slide segments timed to
 * the audio → concat with crossfades → global fade in/out. --static falls back
 * to still frames. Zero npm deps; drives Chrome, say/mlx-audio, ffmpeg.
 */
async function main(): Promise<void> {
  const cfg = toConfig(parseArgs(process.argv.slice(2)));
  await requireTool("ffmpeg", "install with: brew install ffmpeg");
  await requireTool("ffprobe", "ships with ffmpeg");
  if (process.platform !== "darwin") {
    throw new Error(`both voice backends need macOS (say / mlx on Apple Silicon); this is ${process.platform}`);
  }
  if (cfg.tts === "mlx" && !existsSync(cfg.ttsPython)) {
    throw new Error(
      `--tts mlx needs the repo venv at ${cfg.ttsPython} — create it with ` +
        "`uv venv python/venv --python 3.12` then `uv pip install mlx-audio \"misaki[zh]\"`",
    );
  }
  const chrome = await detectChrome();

  const deckDir = resolve(cfg.deckDir);
  if (!existsSync(deckDir)) throw new Error(`deck dir not found: ${deckDir}`);
  const slidesDir = discoverSlidesDir(deckDir, cfg.slidesDir);
  const files = readdirSync(slidesDir).filter((f) => SLIDE_FILE.test(f)).sort(bySlideNumber);
  if (files.length === 0) throw new Error(`no slide-*.html files in ${slidesDir}`);

  const narration = await loadNarration(cfg, files);
  const slides = matchSlides(files, narration);
  console.log(`deck: ${basename(deckDir)} · ${slides.length} slides · voice ${cfg.voice}@${cfg.rate}`);

  const outPath = resolve(cfg.out || join(deckDir, `${basename(slidesDir).replace(/\.slides$/, "")}-narrated.mp4`));
  const workDir = `${outPath}.work`;
  if (cfg.reuse && existsSync(workDir)) {
    console.log(`reusing work dir ${workDir}`);
  } else {
    await cleanup(workDir);
  }
  await mkdir(workDir, { recursive: true });

  // 1. Per-slide render copies: label-reveal patch + injected build animation,
  // served from a temp file inside the slides dir so the URL stays same-origin.
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const tmpCopies: string[] = [];
  const plans: { url: string; framesDir: string; profileDir: string; png: string; wav: string; seg: string }[] = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]!;
    const nn = String(i + 1).padStart(2, "0");
    let servePath = join(slidesDir, s.file);
    if (!cfg.static) {
      let html = await Bun.file(servePath).text();
      if (s.revealLabels && html.includes("return 'map';")) {
        html = html.replace("return 'map';", "return 'read';");
      }
      // Composed slides are HTML fragments (no </body></html>) — append.
      html = html.includes("</body>")
        ? html.replace("</body>", `${INJECT_BLOCK}</body>`)
        : html + INJECT_BLOCK;
      servePath = join(slidesDir, `.video-tmp-${s.file}`);
      await writeFile(servePath, html);
      tmpCopies.push(servePath);
    }
    const rel = relative(process.cwd(), servePath).split("\\").join("/");
    plans.push({
      url: `${baseUrl}/${rel}${s.query ? `?${s.query}` : ""}`,
      framesDir: join(workDir, `frames-${nn}`),
      profileDir: join(workDir, `profile-${nn}`),
      png: join(workDir, `frame-${nn}.png`),
      wav: join(workDir, `line-${nn}.wav`),
      seg: join(workDir, `seg-${nn}.mp4`),
    });
  }

  // 2. Voice first — segment durations (and capture lengths) derive from it.
  const audioDurations: number[] = [];
  for (let i = 0; i < slides.length; i++) {
    const wav = plans[i]!.wav;
    if (cfg.reuse && existsSync(wav)) {
      console.log(`voice ✓ ${basename(wav)}`);
    } else {
      const line = await synthLine(i, slides[i]!.text, wav, cfg);
      console.log(`voice  ${basename(line.wavPath)} · ${line.duration.toFixed(1)}s`);
    }
    audioDurations.push(await probeDuration(wav));
  }

  // 3. Segment durations: lead + audio + tail, clamped up to minSeconds.
  const transition = cfg.transition;
  const segDurations = audioDurations.map((d) => Math.max(cfg.minSeconds, cfg.lead + d + cfg.tail));
  const shortest = Math.min(...segDurations);
  if (shortest <= transition + 0.5) {
    throw new Error(
      `transition ${transition}s is too long for the shortest slide (${shortest.toFixed(1)}s) — ` +
        "raise --seconds or lower --transition",
    );
  }

  // 3. Capture + segments: animated slides are captured frame-by-frame at
  // deterministic timestamps (build-ins play across the narration); --static
  // falls back to a single still frame.
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    if (!cfg.static) {
      const cap = await captureAnimated(plan.url, plan.framesDir, {
        durationSec: segDurations[i]!,
        width: cfg.width,
        height: cfg.height,
        chrome,
        profileDir: plan.profileDir,
      });
      if (cap.count >= 2) {
        await buildSegmentFromFrames(plan.framesDir, cap.times, plan.wav, plan.seg, {
          duration: segDurations[i]!,
          leadMs: Math.round(cfg.lead * 1000),
          fps: cfg.fps,
          index: i,
        });
        console.log(`segment ${String(i + 1).padStart(2, "0")} · ${segDurations[i]!.toFixed(1)}s · ${cap.count} frames (animated)`);
        continue;
      }
      console.log(`capture produced ${cap.count} frames — falling back to a still for slide ${i + 1}`);
    }
    await screenshotSlide(plan.url, plan.png, { width: cfg.width, height: cfg.height, chrome });
    await buildSegment(
      {
        index: i,
        pngPath: plan.png,
        wavPath: plan.wav,
        outPath: plan.seg,
        duration: segDurations[i]!,
        leadMs: Math.round(cfg.lead * 1000),
        width: cfg.width,
        height: cfg.height,
        fps: cfg.fps,
      },
      i % 2 === 0 ? "in" : "out",
    );
    console.log(`segment ${String(i + 1).padStart(2, "0")} · ${segDurations[i]!.toFixed(1)}s (still)`);
  }

  // 5. Final concat with crossfades + global fades.
  const total = await concatSegments(
    plans.map((p) => p.seg),
    segDurations,
    transition,
    outPath,
    { fadeIn: 0.6, fadeOut: 1.2, fps: cfg.fps },
  );

  await cleanup(workDir);
  for (const tmp of tmpCopies) await rm(tmp, { force: true });
  console.log(`done → ${outPath} (${total.toFixed(1)}s, ${slides.length} slides)`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    const extra = err as { stderrTail?: string; stack?: string };
    if (extra?.stderrTail) console.error(extra.stderrTail);
    else if (err instanceof Error && extra?.stack) console.error(extra.stack);
    process.exit(1);
  });
} else {
  // Imported (e.g. by tests) without args: surface usage instead of silently
  // doing nothing.
  void HELP;
}
