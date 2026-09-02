import { describe, expect, test } from "bun:test";
import { computeOffsets, totalDuration } from "../src/lib/assemble.ts";
import { parseArgs, toConfig, HELP } from "../src/lib/config.ts";
import { deriveNarration, matchSlides, slideToText } from "../src/lib/narration.ts";

describe("parseArgs", () => {
  test("flags, values, =-form", () => {
    const args = parseArgs(["--deck", "output/slides-deck", "--rate=150", "--keep", "--voice", "Albert"]);
    expect(args.deck).toBe("output/slides-deck");
    expect(args.rate).toBe("150");
    expect(args.keep).toBe(true);
    expect(args.voice).toBe("Albert");
  });

  test("rejects positionals, duplicates, unknown flags", () => {
    expect(() => parseArgs(["deck"])).toThrow(/positional/);
    expect(() => parseArgs(["--deck", "a", "--deck", "b"])).toThrow(/duplicate/);
    expect(() => toConfig(parseArgs(["--deck", "a", "--nope"]))).toThrow(/unknown flag: --nope/);
  });
});

describe("toConfig", () => {
  test("defaults", () => {
    const cfg = toConfig({ deck: "d" });
    expect(cfg).toMatchObject({
      deckDir: "d", voice: "Samantha", rate: 175, minSeconds: 3,
      lead: 0.5, tail: 0.9, width: 1920, height: 1080, fps: 30, transition: 0.6,
      keep: false, reuse: false, baseUrl: "http://127.0.0.1:8123",
    });
  });

  test("numeric + boolean flags, unknown flag error, help", () => {
    const cfg = toConfig(parseArgs(["--deck", "d", "--seconds", "5", "--keep"]));
    expect(cfg.minSeconds).toBe(5);
    expect(cfg.keep).toBe(true);
    expect(() => toConfig({ deck: "d", wat: true })).toThrow(/unknown flag: --wat/);
    expect(() => toConfig({ help: true })).toThrow(/zcode-generate-slide-video/);
    expect(HELP).toContain("--narration");
  });

  test("mlx backend defaults and validation", () => {
    const cfg = toConfig({ deck: "d", tts: "mlx" });
    expect(cfg.tts).toBe("mlx");
    expect(cfg.voice).toBe("zf_xiaobei");
    expect(cfg.ttsModel).toBe("mlx-community/Kokoro-82M-bf16");
    expect(cfg.ttsLang).toBe("z");
    expect(() => toConfig({ deck: "d", tts: "elevenlabs" })).toThrow(/--tts must be say\|mlx/);
  });
});

describe("computeOffsets / totalDuration", () => {
  test("equal durations", () => {
    expect(computeOffsets([4, 4, 4], 0.6)).toEqual([3.4, 6.8]);
    expect(totalDuration([4, 4, 4], 0.6)).toBeCloseTo(10.8);
  });

  test("unequal durations", () => {
    expect(computeOffsets([5, 3, 6], 0.5)).toEqual([4.5, 7.0]);
    expect(totalDuration([5, 3, 6], 0.5)).toBeCloseTo(13);
  });

  test("single segment has no offsets", () => {
    expect(computeOffsets([7], 0.6)).toEqual([]);
  });
});

describe("narration", () => {
  const manifest = {
    slides: [
      { layout: "title", title: "Ten slides", subtitle: "a deck about decks", eyebrow: "X" },
      { layout: "kpi-row", title: "Three numbers", takeaway: "Restraint wins", kpis: [{ value: "10", label: "Slides" }] },
      { layout: "quote", quote: "Less, but better", attribution: "Dieter Rams" },
    ],
  };

  test("slideToText covers reading order", () => {
    expect(slideToText(manifest.slides[0]!)).toBe("Ten slides. a deck about decks");
    const kpi = slideToText(manifest.slides[1]!);
    expect(kpi).toContain("Three numbers.");
    expect(kpi).toContain("Restraint wins.");
    expect(kpi).toContain("10: Slides.");
  });

  test("deriveNarration produces one entry per slide", () => {
    const derived = deriveNarration(manifest);
    expect(derived.slides).toHaveLength(3);
    expect(derived.slides[1]!.text).toContain("Restraint wins");
  });

  test("matchSlides by explicit file names and by order", () => {
    const files = ["slide-1.html", "slide-2.html"];
    const byFile: Parameters<typeof matchSlides>[1] = {
      slides: [{ file: "slide-2.html", text: "b" }, { file: "slide-1.html", text: "a" }],
    };
    expect(matchSlides(files, byFile).map((s) => s.text)).toEqual(["a", "b"]);
    const byOrder: Parameters<typeof matchSlides>[1] = { slides: [{ text: "x" }, { text: "y" }] };
    expect(matchSlides(files, byOrder).map((s) => s.text)).toEqual(["x", "y"]);
  });

  test("matchSlides rejects count mismatch without file names", () => {
    expect(() =>
      matchSlides(["slide-1.html", "slide-2.html"], { slides: [{ text: "only one" }] }),
    ).toThrow(/match counts/);
  });
});
