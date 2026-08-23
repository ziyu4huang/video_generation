import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateThumbnails, slideHtmlPaths, thumbPathFor } from "../src/thumbnails.ts";
import { buildDeck, defaultSlidesDir, type DeckManifest } from "../src/deck-build.ts";
import type { OpenBus } from "../src/open-announce.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PKG_ROOT, "vendored", "examples");
const work = mkdtempSync(join(tmpdir(), "archify-thumbs-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("thumbPathFor", () => {
  test("sits beside the slide with an obvious name", () => {
    expect(thumbPathFor("/a/slide-1.html")).toBe("/a/slide-1.thumb.webp");
    expect(thumbPathFor("/a/SLIDE-2.HTML")).toBe("/a/SLIDE-2.thumb.webp");
  });
});

describe("slideHtmlPaths", () => {
  test("enumerates a persisted deck's slides", () => {
    expect(slideHtmlPaths("/d", 3)).toEqual(["/d/slide-1.html", "/d/slide-2.html", "/d/slide-3.html"]);
  });
});

describe("generateThumbnails", () => {
  test("renders a real WebP for a real artifact", async () => {
    const outputPath = join(work, "thumbs.pptx");
    const slidesDir = defaultSlidesDir(outputPath);
    const manifest: DeckManifest = {
      slides: [{ ir: join(EXAMPLES, "web-app.architecture.json"), title: "Arch" }],
    };
    await buildDeck({ manifest, manifestDir: EXAMPLES, outputPath, cwd: PKG_ROOT, slidesDir });

    const html = join(slidesDir, "slide-1.html");
    const [thumb] = await generateThumbnails([html], { width: 240 });
    expect(thumb).toBe(thumbPathFor(html));
    expect(existsSync(thumb!)).toBe(true);

    const bytes = await Bun.file(thumb!).bytes();
    // RIFF....WEBP — assert the actual container, not just a non-empty file.
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WEBP");
    expect(bytes.length).toBeGreaterThan(500);
  }, 120_000);

  test("reuses a fresh thumbnail instead of re-rendering", async () => {
    const slidesDir = defaultSlidesDir(join(work, "thumbs.pptx"));
    const html = join(slidesDir, "slide-1.html");
    const thumb = thumbPathFor(html);
    const before = (await Bun.file(thumb).stat()).mtimeMs;
    const t0 = performance.now();
    const [again] = await generateThumbnails([html]);
    const elapsed = performance.now() - t0;
    expect(again).toBe(thumb);
    expect((await Bun.file(thumb).stat()).mtimeMs).toBe(before);
    // A cache hit must not start an engine — that is the whole point.
    expect(elapsed).toBeLessThan(200);
  }, 60_000);

  test("re-renders when the slide is newer than its thumbnail", async () => {
    const slidesDir = defaultSlidesDir(join(work, "thumbs.pptx"));
    const html = join(slidesDir, "slide-1.html");
    const thumb = thumbPathFor(html);
    const future = new Date(Date.now() + 10_000);
    utimesSync(html, future, future);
    const before = (await Bun.file(thumb).stat()).mtimeMs;
    await generateThumbnails([html], { width: 200 });
    expect((await Bun.file(thumb).stat()).mtimeMs).toBeGreaterThan(before);
  }, 120_000);

  test("a missing source yields null instead of throwing", async () => {
    expect(await generateThumbnails([join(work, "nope.html")])).toEqual([null]);
  }, 60_000);

  test("an empty input starts no engine and returns nothing", async () => {
    const t0 = performance.now();
    expect(await generateThumbnails([])).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("buildDeck thumbnails option", () => {
  const bus = (): OpenBus & { seen: [string, unknown][] } => {
    const seen: [string, unknown][] = [];
    return { seen, emit: (c: string, p: unknown) => void seen.push([c, p]) };
  };

  test("off by default — no thumbnails, no thumb in the announce", async () => {
    const b = bus();
    const outputPath = join(work, "nothumbs.pptx");
    await buildDeck({
      manifest: { slides: [{ ir: join(EXAMPLES, "agent-run.lifecycle.json"), title: "L" }] },
      manifestDir: EXAMPLES,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir: defaultSlidesDir(outputPath),
      events: b,
    });
    const payload = b.seen[0]![1] as { slides: { thumb?: string }[] };
    expect(payload.slides[0]!.thumb).toBeUndefined();
    expect(existsSync(thumbPathFor(join(defaultSlidesDir(outputPath), "slide-1.html")))).toBe(false);
  }, 60_000);

  test("thumbnails:true puts a thumb path in the announce", async () => {
    const b = bus();
    const outputPath = join(work, "withthumbs.pptx");
    await buildDeck({
      manifest: { slides: [{ ir: join(EXAMPLES, "agent-run.lifecycle.json"), title: "L" }] },
      manifestDir: EXAMPLES,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir: defaultSlidesDir(outputPath),
      thumbnails: true,
      events: b,
    });
    const payload = b.seen[0]![1] as { slides: { thumb?: string }[] };
    expect(payload.slides[0]!.thumb).toBeDefined();
    expect(existsSync(payload.slides[0]!.thumb!)).toBe(true);
  }, 120_000);
});
