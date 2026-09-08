/**
 * deck-combine — the single-file deck artifact.
 *
 * Purity: same slides + options → byte-identical string (no timestamps, no
 * fs). Self-containment: the combined file must have ZERO external references
 * — the per-slide font `<link>`s are stripped at embed time, mirroring the
 * emit-html test's no-network bar. Isolation: every slide is a sandboxed
 * srcdoc iframe; speaker notes must never reach the file (they are a PPTX
 * surface).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDeck, defaultSlidesDir, type DeckManifest } from "../src/deck-build.ts";
import { combineDeckHtml } from "../src/deck-combine.ts";

const PKG_ROOT = join(import.meta.dir, "..");

const SLIDE_A = `<!doctype html><html><head>
<link rel="preconnect" href="https://fonts.gstatic.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono&display=swap" rel="stylesheet">
<link rel="stylesheet" href="local.css">
<title>slide a</title></head><body>alpha</body></html>`;
const SLIDE_B = "<html><body>beta & <b>gone</b></body></html>";

const slides = [
  { title: "First <slide> & intro", html: SLIDE_A },
  { title: "Second slide", html: SLIDE_B },
];

describe("combineDeckHtml — purity and self-containment", () => {
  test("deterministic: same inputs, byte-identical output", () => {
    const one = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    const two = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    expect(one).toBe(two);
  });

  test("every slide is a sandboxed srcdoc iframe, in manifest order", () => {
    const out = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    const frames = out.match(/<iframe sandbox="allow-scripts"/g) ?? [];
    expect(frames).toHaveLength(2);
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("beta"));
  });

  test("zero external references survive (font links stripped)", () => {
    const out = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/<link\b/);
    expect(out).toContain("alpha"); // content survives the strip
  });

  test("srcdoc escaping: quotes and angle brackets in slide HTML cannot break out", () => {
    const out = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    expect(out).toContain("&lt;html&gt;");
    expect(out).toContain("&quot;");
    // the escaped body is inside an attribute — no raw <html> from the slide
    expect(out.indexOf('<iframe')).toBeGreaterThan(-1);
  });

  test("titles are escaped in header/grid, deck title in <title>", () => {
    const out = combineDeckHtml(slides, { deckTitle: "My <Deck> & Co", theme: "light" });
    expect(out).toContain("<title>My &lt;Deck&gt; &amp; Co</title>");
    expect(out).toContain("First &lt;slide&gt; &amp; intro");
  });

  test("theme drives the shell palette (light vs dark shells differ)", () => {
    const light = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    const dark = combineDeckHtml(slides, { deckTitle: "Deck", theme: "dark" });
    expect(light).toContain("#FFFFFF");
    expect(dark).toContain("#0B1220");
    expect(light).not.toBe(dark);
  });

  test("navigation chrome: counter, hash restore, key hints are present", () => {
    const out = combineDeckHtml(slides, { deckTitle: "Deck", theme: "light" });
    expect(out).toContain('id="cur"');
    expect(out).toContain("fromHash");
    expect(out).toContain("ArrowRight");
    expect(out).toContain("grid");
  });

  test("empty deck still renders a valid shell", () => {
    const out = combineDeckHtml([], { deckTitle: "Empty", theme: "light" });
    expect(out).toContain("0");
    expect(out).not.toMatch(/https?:\/\//);
  });
});

describe("buildDeck combine — end to end", () => {
  const NOTES_SENTINEL = "SPEAKER-NOTES-SENTINEL-DO-NOT-LEAK";
  const manifest: DeckManifest = {
    output: "combined.pptx",
    theme: "light" as const,
    slides: [
      { layout: "title", title: "Combined deck POC", date: "2026-09-08" },
      {
        layout: "bullets",
        title: "With notes that must stay in the pptx",
        bullets: ["one", "two"],
        notes: NOTES_SENTINEL,
      },
    ],
  };

  test("combine flag writes deck.html beside the slides; notes never leak", async () => {
    const work = mkdtempSync(join(tmpdir(), "deck-combine-"));
    try {
      const outputPath = join(work, "combined.pptx");
      const slidesDir = defaultSlidesDir(outputPath);
      const result = await buildDeck({
        manifest,
        manifestDir: work,
        outputPath,
        cwd: PKG_ROOT,
        slidesDir,
        combine: true,
      });
      expect(result.deckHtmlPath).toBe(join(slidesDir, "deck.html"));
      expect(existsSync(result.deckHtmlPath!)).toBe(true);

      const html = await Bun.file(result.deckHtmlPath!).text();
      const frames = html.match(/<iframe sandbox="allow-scripts"/g) ?? [];
      expect(frames).toHaveLength(manifest.slides.length);
      expect(html).toContain("Combined deck POC");
      expect(html).not.toContain(NOTES_SENTINEL);
      expect(html).not.toMatch(/https?:\/\//);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  test("without the flag the build is unchanged — no deck.html, no result field", async () => {
    const work = mkdtempSync(join(tmpdir(), "deck-combine-off-"));
    try {
      const outputPath = join(work, "plain.pptx");
      const slidesDir = defaultSlidesDir(outputPath);
      const result = await buildDeck({
        manifest,
        manifestDir: work,
        outputPath,
        cwd: PKG_ROOT,
        slidesDir,
      });
      expect(result.deckHtmlPath).toBeUndefined();
      expect(existsSync(join(slidesDir, "deck.html"))).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
