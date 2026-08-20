import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeck, defaultSlidesDir, type DeckManifest } from "../lib/deck-build.ts";
import { announceDeck, deckAnnounceFor, type OpenBus } from "../lib/open-announce.ts";
import { archifyExportPptx } from "../lib/export-pptx.ts";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PKG_ROOT, "vendored", "examples");
const IR_A = join(EXAMPLES, "web-app.architecture.json");
const IR_B = join(EXAMPLES, "agent-run.lifecycle.json");

const work = mkdtempSync(join(tmpdir(), "archify-deck-announce-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A bus that records emissions; `throws` models a hostile/broken host. */
function bus(opts: { throws?: boolean } = {}): OpenBus & { seen: [string, unknown][] } {
  const seen: [string, unknown][] = [];
  return {
    seen,
    emit(channel: string, payload: unknown) {
      if (opts.throws) throw new Error("bus exploded");
      seen.push([channel, payload]);
    },
  };
}

const manifest = (slides: { ir: string; title: string; subtitle?: string }[]): DeckManifest => ({
  tag: "announce test",
  slides,
});

describe("deckAnnounceFor — pure payload", () => {
  test("deckId is the .pptx basename, so a re-export replaces rather than stacks", () => {
    const p = deckAnnounceFor("/a/b/quarterly.pptx", [{ path: "/a/b/s1.html", title: "One" }]);
    expect(p.deckId).toBe("quarterly");
    expect(p.title).toBe("quarterly");
  });

  test("an explicit title wins over the derived one", () => {
    const p = deckAnnounceFor("/a/b/q.pptx", [{ path: "/s.html", title: "One" }], "Q3 review");
    expect(p.title).toBe("Q3 review");
  });

  test("slide paths are absolutized and order is preserved", () => {
    const p = deckAnnounceFor("/a/b/q.pptx", [
      { path: "/x/1.html", title: "One", subtitle: "arch" },
      { path: "/x/2.html", title: "Two" },
    ]);
    expect(p.slides).toEqual([
      { path: "/x/1.html", title: "One", subtitle: "arch" },
      { path: "/x/2.html", title: "Two" },
    ]);
  });
});

describe("announceDeck — webui-optional", () => {
  test("emits webui:deck on a present bus", () => {
    const b = bus();
    announceDeck(b, "/a/deck.pptx", [{ path: "/a/s1.html", title: "One" }]);
    expect(b.seen).toHaveLength(1);
    expect(b.seen[0]![0]).toBe("webui:deck");
  });

  test("no bus is a silent no-op", () => {
    expect(() => announceDeck(undefined, "/a/deck.pptx", [{ path: "/s.html", title: "T" }])).not.toThrow();
  });

  test("a throwing bus never escapes", () => {
    expect(() =>
      announceDeck(bus({ throws: true }), "/a/deck.pptx", [{ path: "/s.html", title: "T" }])
    ).not.toThrow();
  });

  test("an empty slide list emits nothing", () => {
    const b = bus();
    announceDeck(b, "/a/deck.pptx", []);
    expect(b.seen).toHaveLength(0);
  });
});

describe("buildDeck — slide persistence drives the announce", () => {
  test("a persisted deck keeps its slides and announces them in manifest order", async () => {
    const outputPath = join(work, "persisted.pptx");
    const slidesDir = defaultSlidesDir(outputPath);
    const b = bus();
    const result = await buildDeck({
      manifest: manifest([
        { ir: IR_A, title: "Arch", subtitle: "architecture" },
        { ir: IR_B, title: "Life", subtitle: "lifecycle" },
      ]),
      manifestDir: EXAMPLES,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir,
      events: b,
    });

    expect(result.slidesDir).toBe(slidesDir);
    expect(existsSync(join(slidesDir, "slide-1.html"))).toBe(true);
    expect(existsSync(join(slidesDir, "slide-2.html"))).toBe(true);

    expect(b.seen).toHaveLength(1);
    const [channel, payload] = b.seen[0]!;
    expect(channel).toBe("webui:deck");
    const p = payload as { deckId: string; slides: { path: string; title: string }[] };
    expect(p.deckId).toBe("persisted");
    expect(p.slides.map((s) => s.title)).toEqual(["Arch", "Life"]);
    // The announced paths must be the PERSISTED ones — announcing temp paths
    // that the build then deletes is the obvious way to get this wrong.
    for (const s of p.slides) expect(existsSync(s.path)).toBe(true);
  }, 60_000);

  test("slidesDir:null keeps only the .pptx and announces nothing", async () => {
    const outputPath = join(work, "ephemeral.pptx");
    const b = bus();
    const result = await buildDeck({
      manifest: manifest([{ ir: IR_B, title: "Life" }]),
      manifestDir: EXAMPLES,
      outputPath,
      cwd: PKG_ROOT,
      slidesDir: null,
      events: b,
    });
    expect(result.slidesDir).toBeUndefined();
    expect(b.seen).toHaveLength(0);
    expect(existsSync(outputPath)).toBe(true);
    expect(existsSync(defaultSlidesDir(outputPath))).toBe(false);
  }, 60_000);

  test("re-exporting the same deck reuses the id (replace, not duplicate)", async () => {
    const outputPath = join(work, "stable.pptx");
    const b = bus();
    for (let i = 0; i < 2; i++) {
      await buildDeck({
        manifest: manifest([{ ir: IR_B, title: "Life" }]),
        manifestDir: EXAMPLES,
        outputPath,
        cwd: PKG_ROOT,
        slidesDir: defaultSlidesDir(outputPath),
        events: b,
      });
    }
    expect(b.seen).toHaveLength(2);
    const ids = b.seen.map(([, p]) => (p as { deckId: string }).deckId);
    expect(ids).toEqual(["stable", "stable"]);
  }, 120_000);
});

describe("defaultSlidesDir", () => {
  test("sits beside the .pptx with a name that says what it is", () => {
    expect(defaultSlidesDir("/a/b/deck.pptx")).toBe("/a/b/deck.slides");
    expect(defaultSlidesDir("/a/b/DECK.PPTX")).toBe("/a/b/DECK.slides");
  });
});

describe("archify_export_pptx — the tool announces too", () => {
  test("emits webui:deck with servable paths", async () => {
    const b = bus();
    const outputPath = join(work, "tool-announce.pptx");
    const r = await archifyExportPptx(
      { irPaths: [IR_A], outputPath },
      { cwd: PKG_ROOT, events: b }
    );
    expect(r.isError).toBeUndefined();
    expect(r.details["slidesDir"]).toBe(defaultSlidesDir(outputPath));
    expect(b.seen.map(([c]) => c)).toEqual(["webui:deck"]);
    expect(r.content[0]!.text).toContain("Interactive slides:");
  }, 60_000);

  test("slidesDir:null opts out of both the files and the announce", async () => {
    const b = bus();
    const outputPath = join(work, "tool-quiet.pptx");
    const r = await archifyExportPptx(
      { irPaths: [IR_A], outputPath, slidesDir: null },
      { cwd: PKG_ROOT, events: b }
    );
    expect(r.isError).toBeUndefined();
    expect(r.details["slidesDir"]).toBeUndefined();
    expect(b.seen).toHaveLength(0);
    expect(r.content[0]!.text).not.toContain("Interactive slides:");
  }, 60_000);

  test("works with no bus at all (webui absent)", async () => {
    const r = await archifyExportPptx(
      { irPaths: [IR_B], outputPath: join(work, "no-bus.pptx") },
      { cwd: PKG_ROOT }
    );
    expect(r.isError).toBeUndefined();
  }, 60_000);
});
