#!/usr/bin/env bun
//
// archify deck — IR[] / Markdown outline → PPTX slide deck of NATIVE, EDITABLE shapes.
//
//   bun run deck [manifest] [--outline <file>] [--theme light|dark] [--output out.pptx]
//                [--slides-dir <dir> | --no-slides] [--thumbnails]
//                [--emit-shape-ir <dir>] [--lint]
//   bun run deck render <manifest> [--out <dir>] [--size <px>]
//                [--theme light|dark] [--output out.pptx]
//
// `render` builds the deck and pictures every slide as slide-N.png through the
// first available backend (quicklook on darwin, libreoffice elsewhere). It is
// an on-demand command for human eyes, never a build gate; with no backend it
// exits non-zero naming what it looked for. See lib/deck-render.ts.
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
// `--outline <file>` swaps the manifest for a Markdown outline (lib/outline.ts):
// frontmatter carries output/theme/tag/defaults; the body's markers cover the
// six code layouts and fenced :::name JSON payloads reach the layout templates.
// Both doors go through the same resolveDeckInput() as the manifest, so the
// input shapes cannot drift. A slide with `ir` and no `layout` is a diagram
// slide, so every manifest written before layouts existed still builds
// unchanged. The six layouts are `title`, `section`, `bullets`, `split`,
// `diagram` and `statement`; see the README.
//
// `--lint` additionally prints the title storyline (the deck's argument read from
// the titles alone), the advisory content notes, and the OOXML structural
// diagnostics for the file just written. It never changes the exit code — but a
// deck whose action title is too wide for its band never gets this far: the
// build itself refuses it, with or without `--lint`.
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
  resolveDeckInput,
  resolveDeckOutput,
  type Theme,
} from "../lib/deck-build.ts";
import { defaultRendersDir, pickRenderer, rendererStatus } from "../lib/deck-render.ts";
import { formatLintNotes, lintDeck, storyline } from "../lib/deck-lint.ts";
import { formatDiagnostics, lintPptx } from "../lib/ooxml-lint.ts";
import { readZipText } from "../lib/read-zip.ts";
import { VENDORED_BIN } from "../lib/run.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface DeckArgs {
  manifest: string;
  /** Markdown outline file; replaces the manifest as the input shape. */
  outline?: string;
  theme?: Theme;
  output?: string;
  emitShapeIr?: string;
  /** Where the rendered slide HTML goes. `null` = do not keep it. */
  slidesDir?: string | null;
  /** Render a thumbnail per slide (costs a page load each). */
  thumbnails?: boolean;
  /** Print storyline + advisory content notes + OOXML diagnostics. */
  lint?: boolean;
}

export function parseArgs(argv: string[]): DeckArgs {
  const positional: string[] = [];
  let outline: string | undefined;
  let theme: Theme | undefined;
  let output: string | undefined;
  let emitShapeIr: string | undefined;
  let slidesDir: string | null | undefined;
  let thumbnails = false;
  let lint = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === "--outline") {
      outline = argv[++i];
      continue;
    }
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
    if (a === "--lint") {
      lint = true;
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
    ...(outline ? { outline } : {}),
    ...(theme ? { theme } : {}),
    ...(output ? { output } : {}),
    ...(emitShapeIr ? { emitShapeIr } : {}),
    ...(slidesDir !== undefined ? { slidesDir } : {}),
    ...(thumbnails ? { thumbnails } : {}),
    ...(lint ? { lint } : {}),
  };
}

function fail(msg: string): never {
  console.error(`deck: ${msg}`);
  process.exit(1);
}

export interface RenderArgs extends DeckArgs {
  /** Where the slide-N.png images go. Default: `<output>.renders/`. */
  rendersDir?: string;
  /** Longest image edge in px. Default 1600. */
  size?: number;
}

/** `deck render <config> [--out <dir>] [--size <px>] [--theme …] [--output …]` */
export function parseRenderArgs(argv: string[]): RenderArgs {
  if (argv[0] === undefined || argv[0].startsWith("--")) {
    throw new Error("render needs a <config> positional (the deck manifest)");
  }
  const rest = [...argv];
  const config = rest.shift()!;
  const outIdx = rest.indexOf("--out");
  let rendersDir: string | undefined;
  if (outIdx !== -1) {
    rendersDir = rest[outIdx + 1];
    if (rendersDir === undefined) throw new Error("--out needs a directory");
    rest.splice(outIdx, 2);
  }
  const sizeIdx = rest.indexOf("--size");
  let size: number | undefined;
  if (sizeIdx !== -1) {
    const raw = rest[sizeIdx + 1];
    const parsed = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 8192) {
      throw new Error(`--size must be a positive integer ≤ 8192, got "${raw}"`);
    }
    size = parsed;
    rest.splice(sizeIdx, 2);
  }
  return { ...parseArgs([config, ...rest]), ...(rendersDir ? { rendersDir } : {}), ...(size ? { size } : {}) };
}

/**
 * `deck render` — build the deck, then picture every slide as slide-N.png.
 *
 * The seam is D1's "on-demand command": the renderer SEES, it never gates.
 * No backend on this machine is a named, non-zero exit — never a stack trace,
 * never a silent success.
 */
async function runRender(args: RenderArgs): Promise<void> {
  const cwd = process.cwd();
  const renderer = pickRenderer();
  if (!renderer) {
    const looked = rendererStatus()
      .map((r) => `  ${r.id}: needs ${r.looksFor.join(" + ")} — not found here`)
      .join("\n");
    fail(`no render backend on this machine\n${looked}`);
  }

  const input = await resolveDeckInput(args.outline ? { outlinePath: args.outline } : { manifestPath: args.manifest }, cwd);
  const { manifest, manifestDir } = input;
  const outputPath = resolveDeckOutput(manifest, manifestDir, cwd, args.output);
  const result = await buildDeck({
    manifest,
    manifestDir,
    outputPath,
    cwd: PKG_ROOT,
    ...(args.theme ? { theme: args.theme } : {}),
    slidesDir: null, // rendering pictures the .pptx; the HTML pages are not kept
    onProgress: (m) => console.log(m),
  });
  const outDir = args.rendersDir
    ? resolve(cwd, args.rendersDir)
    : defaultRendersDir(result.output);
  const images = await renderer.renderSlides(result.output, outDir, args.size ? { size: args.size } : undefined);
  console.log(
    `rendered ${images.length} slides via ${renderer.id} → ${outDir} ` +
      `(backend: ${renderer.id}, os: ${process.platform})`
  );
  for (const img of images) console.log(`  ${img}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "render") {
    return runRender(parseRenderArgs(argv.slice(1)));
  }
  const args = parseArgs(argv);
  const cwd = process.cwd();

  if (!(await Bun.file(VENDORED_BIN).exists())) {
    fail(`vendored archify bin not found at ${VENDORED_BIN} (set PI_ARCHIFY_BIN to override)`);
  }

  const input = await resolveDeckInput(args.outline ? { outlinePath: args.outline } : { manifestPath: args.manifest }, cwd);
  const { manifest, manifestDir } = input;
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

  if (args.lint) {
    console.log("\nstoryline — read these alone; they are the deck's argument:");
    console.log(storyline(manifest));

    const notes = lintDeck(manifest);
    console.log(
      notes.length === 0 ? "\ncontent lint: clean" : `\ncontent lint (${notes.length}):\n${formatLintNotes(notes)}`
    );

    const parts = await readZipText(new Uint8Array(await Bun.file(outputPath).arrayBuffer()));
    const diags = await lintPptx(parts);
    console.log(
      diags.length === 0
        ? `ooxml lint: clean (${Object.keys(parts).length} parts)`
        : `ooxml lint (${diags.length}):\n${formatDiagnostics(diags)}`
    );
  }
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof DeckError) fail(e.message);
    fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
  });
}
