#!/usr/bin/env bun
//
// archify deck — IR[] → PPTX slide deck of NATIVE, EDITABLE shapes.
//
//   bun run deck [manifest] [--theme light|dark] [--output out.pptx]
//                [--slides-dir <dir> | --no-slides] [--thumbnails]
//                [--emit-shape-ir <dir>]
//
// Thin CLI over lib/deck-build.ts, which both this and the `archify_export_pptx`
// tool share so they can never drift.
//
// Manifest (default deck.config.json):
//   {
//     "output": "out.pptx",
//     "theme": "light",
//     "tag": "archify deck",
//     "defaults": { "font": "PingFang TC" },
//     "slides": [ { "ir": "slide1.json", "title": "…", "subtitle": "…" } ]
//   }
//
// `ir` / `output` resolve relative to the manifest dir (portable manifest);
// `--output` resolves relative to cwd. `defaults.scale` is accepted and ignored —
// it configured the old raster path and has no meaning for vector shapes.
//
// The rendered slide HTML is kept beside the .pptx in `<output>.slides/` (or
// `--slides-dir`, or nowhere with `--no-slides`). Those files ARE the diagrams —
// full-fidelity and interactive — and they are what a webui's Diagram pane
// serves; the .pptx is the flattened, portable view of the same set.
//
// No browser is involved: slides carry real PowerPoint shapes and text runs, not
// screenshots. `__tests__/pptx-shapes.test.ts` asserts zero `<a:blip>` in the
// slide XML, which is the property a regression to images cannot fake.
//
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeck,
  DeckError,
  defaultSlidesDir,
  loadManifestFile,
  resolveDeckOutput,
  type Theme,
} from "../lib/deck-build.ts";
import { VENDORED_BIN } from "../lib/run.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DeckArgs {
  manifest: string;
  theme?: Theme;
  output?: string;
  emitShapeIr?: string;
  /** Where the rendered slide HTML goes. `null` = do not keep it. */
  slidesDir?: string | null;
  /** Render a thumbnail per slide (costs a page load each). */
  thumbnails?: boolean;
}

export function parseArgs(argv: string[]): DeckArgs {
  const positional: string[] = [];
  let theme: Theme | undefined;
  let output: string | undefined;
  let emitShapeIr: string | undefined;
  let slidesDir: string | null | undefined;
  let thumbnails = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--theme") {
      theme = argv[++i] as Theme;
      continue;
    }
    if (a === "--output") {
      output = argv[++i];
      continue;
    }
    if (a === "--emit-shape-ir") {
      emitShapeIr = argv[++i];
      continue;
    }
    if (a === "--slides-dir") {
      slidesDir = argv[++i];
      continue;
    }
    if (a === "--no-slides") {
      slidesDir = null;
      continue;
    }
    if (a === "--thumbnails") {
      thumbnails = true;
      continue;
    }
    if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    positional.push(a);
  }
  if (theme && theme !== "light" && theme !== "dark") {
    throw new Error(`--theme must be light|dark, got "${theme}"`);
  }
  return {
    manifest: positional[0] ?? "deck.config.json",
    ...(theme ? { theme } : {}),
    ...(output ? { output } : {}),
    ...(emitShapeIr ? { emitShapeIr } : {}),
    ...(slidesDir !== undefined ? { slidesDir } : {}),
    ...(thumbnails ? { thumbnails } : {}),
  };
}

function fail(msg: string): never {
  console.error(`deck: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (!(await Bun.file(VENDORED_BIN).exists())) {
    fail(`vendored archify bin not found at ${VENDORED_BIN} (set PI_ARCHIFY_BIN to override)`);
  }

  const { manifest, manifestDir } = await loadManifestFile(args.manifest, cwd);
  const outputPath = resolveDeckOutput(manifest, manifestDir, cwd, args.output);

  const result = await buildDeck({
    manifest,
    manifestDir,
    outputPath,
    cwd: PKG_ROOT,
    ...(args.theme ? { theme: args.theme } : {}),
    ...(args.emitShapeIr ? { emitShapeIrDir: resolve(cwd, args.emitShapeIr) } : {}),
    // Keep the rendered slides by default — they ARE the diagrams, and the
    // .pptx is their flattened view. `--no-slides` opts out.
    slidesDir:
      args.slidesDir === null
        ? null
        : args.slidesDir
          ? resolve(cwd, args.slidesDir)
          : defaultSlidesDir(outputPath),
    ...(args.thumbnails ? { thumbnails: true } : {}),
    onProgress: (m) => console.log(m),
  });

  const shapes = result.slides.reduce((a, s) => a + s.shapes + s.texts, 0);
  console.log(
    `saved ${result.output} (${(result.bytes / 1024).toFixed(0)} KB, ` +
      `${result.slides.length} slides, ${shapes} native shapes, theme=${result.theme})`
  );
  if (result.slidesDir) console.log(`slides  ${result.slidesDir}`);
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof DeckError) fail(e.message);
    fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
  });
}
