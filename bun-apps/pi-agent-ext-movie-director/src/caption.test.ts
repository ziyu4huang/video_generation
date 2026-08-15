import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCaptionArgs,
  captionPathFor,
  readCaption,
  runPyCaption,
  type CaptionOptions,
} from "./caption.ts";

// Sandboxed temp dir for fake <image>.caption.json files.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-caption-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildCaptionArgs", () => {
  it("minimal: just the image + caption subcommand (run.py defaults style/lang)", () => {
    expect(buildCaptionArgs({ image: "/x/y.png" })).toEqual(["caption", "/x/y.png"]);
  });

  it("single style + lang + model override + no-auto-load", () => {
    expect(
      buildCaptionArgs({
        image: "/x/y.png",
        style: "score",
        lang: "en",
        model: "google/gemma-4-12b",
        noAutoLoad: true,
      }),
    ).toEqual([
      "caption", "/x/y.png",
      "--style", "score",
      "--lang", "en",
      "--model", "google/gemma-4-12b",
      "--no-auto-load",
    ]);
  });

  it("multi-style expands into one --style with N values (run.py nargs='+')", () => {
    expect(
      buildCaptionArgs({ image: "/x/y.png", style: ["t2i", "score"], lang: "zh_TW" }),
    ).toEqual([
      "caption", "/x/y.png",
      "--style", "t2i", "score",
      "--lang", "zh_TW",
    ]);
  });
});

describe("captionPathFor + readCaption", () => {
  it("caption path is <stem>.caption.json beside the input (extension stripped, like run.py splitext)", () => {
    expect(captionPathFor("/x/y.png")).toBe("/x/y.caption.json");
    expect(captionPathFor("/x/y.tar.gz")).toBe("/x/y.tar.caption.json"); // last ext only
    expect(captionPathFor("/x/noext")).toBe("/x/noext.caption.json");
    expect(captionPathFor("/x.d/file.png")).toBe("/x.d/file.caption.json"); // dot in dir not stripped
  });

  it("parses a single-style score caption (model + text + style key)", () => {
    const img = join(dir, "a.png");
    writeFileSync(
      captionPathFor(img),
      JSON.stringify({
        image: img,
        style: "score",
        model: "google/gemma-4-12b",
        caption: '{"overall": 7, "issues": ["oversmoothed skin"]}',
      }),
    );
    const r = readCaption(captionPathFor(img))!;
    expect(r.model).toBe("google/gemma-4-12b");
    expect(r.styles).toEqual(["score"]);
    expect(r.text).toContain("overall");
  });

  it("parses a multi-style caption (styles map → JSON-stringified text)", () => {
    const img = join(dir, "b.png");
    writeFileSync(
      captionPathFor(img),
      JSON.stringify({
        image: img,
        model: "google/gemma-4-12b",
        styles: { t2i: "a portrait", score: '{"overall": 8}' },
      }),
    );
    const r = readCaption(captionPathFor(img))!;
    expect(r.model).toBe("google/gemma-4-12b");
    expect(r.styles).toEqual(["t2i", "score"]);
    expect(r.text).toContain("a portrait");
    expect(r.text).toContain("overall");
  });

  it("returns null for a missing/unreadable file (never throws)", () => {
    expect(readCaption(join(dir, "nope.png.caption.json"))).toBeNull();
  });
});

describe("runPyCaption — spawn injection (no venv / no LM Studio)", () => {
  it("ok=true when run.py exits 0 AND the caption JSON lands + parses", async () => {
    const img = join(dir, "ok.png");
    // The injected spawn simulates run.py writing the caption JSON as a side effect.
    const opts: CaptionOptions = { image: img, style: "score", lang: "en" };
    writeFileSync(
      captionPathFor(img),
      JSON.stringify({
        image: img,
        style: "score",
        model: "google/gemma-4-12b",
        caption: '{"overall": 7}',
      }),
    );
    const out = await runPyCaption({
      options: opts,
      _spawnImpl: async () => ({ stdout: "[caption] done", stderr: "", exitCode: 0 }),
    });
    expect(out.details.ok).toBe(true);
    expect(out.details.exitCode).toBe(0);
    expect(out.details.model).toBe("google/gemma-4-12b");
    expect(out.details.styles).toEqual(["score"]);
    expect(out.details.captionPath).toBe(captionPathFor(img));
    expect(out.details.text).toContain("overall");
    expect(out.summary).toContain("score");
    expect(out.summary).toContain("gemma-4-12b");
  });

  it("ok=false when run.py exits 0 but wrote NO caption JSON (0-exit ≠ success)", async () => {
    const img = join(dir, "empty.png"); // never written
    const out = await runPyCaption({
      options: { image: img, style: "score" },
      _spawnImpl: async () => ({ stdout: "[caption] (nothing written)", stderr: "", exitCode: 0 }),
    });
    expect(out.details.ok).toBe(false);
    expect(out.details.captionPath).toBeNull();
    expect(out.details.model).toBeNull();
    expect(out.summary).toContain("FAILED");
  });

  it("ok=false on non-zero exit", async () => {
    const img = join(dir, "fail.png");
    const out = await runPyCaption({
      options: { image: img },
      _spawnImpl: async () => ({ stdout: "", stderr: "boom: model not loaded", exitCode: 2 }),
    });
    expect(out.details.ok).toBe(false);
    expect(out.details.exitCode).toBe(2);
    expect(out.stderrTail).toContain("boom");
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const img = join(dir, "throw.png");
    const out = await runPyCaption({
      options: { image: img },
      _spawnImpl: async () => {
        throw new Error("ENOENT: python");
      },
    });
    expect(out.details.ok).toBe(false);
    expect(out.summary).toContain("spawn failed");
    expect(out.summary).toContain("ENOENT");
  });
});
