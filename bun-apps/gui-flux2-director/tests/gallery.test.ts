import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "fs";
import path from "path";

import { listGallery, parseOutputBase } from "../lib/gallery";

let fixtureSeq = 0;

function fixture(): string {
  fixtureSeq += 1;
  const dir = path.join("/tmp", `flux2-gui-gallery-${process.pid}-${Date.now()}-${fixtureSeq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTrio(dir: string, base: string, prompt: string, seed: number, mtime: Date): void {
  writeFileSync(path.join(dir, `${base}.png`), "png");
  writeFileSync(
    path.join(dir, `${base}.run.json`),
    JSON.stringify({
      prompt,
      negative_prompt: "blurry",
      steps: 8,
      cfg_scale: 1.5,
      transformer: "klein-9b-dark-beast-bfs",
      seed: 42,
      lora_paths: ["details-9b", "qualitya"],
      lora_scales: [0.8, 1.0],
      command: "t2i",
      created_at: "2026-09-03T20:19:28Z",
    }),
  );
  writeFileSync(
    path.join(dir, `${base}.manifest.json`),
    JSON.stringify({
      output_files: [{ path: `${base}.png`, seed, width: 1024, height: 1024 }],
      timings: { generation: 12.3 },
    }),
  );
  utimesSync(path.join(dir, `${base}.png`), mtime, mtime);
}

describe("parseOutputBase", () => {
  test("merges run.json + manifest.json into one item", () => {
    const dir = fixture();
    writeTrio(dir, "output_1", "a cat", 42, new Date());
    const item = parseOutputBase(dir, "output_1", 1);
    expect(item?.png).toBe(path.join(dir, "output_1.png"));
    expect(item?.prompt).toBe("a cat");
    expect(item?.steps).toBe(8);
    expect(item?.seed).toBe("42");
    expect(item?.loras).toEqual(["details-9b", "qualitya"]);
    // Regenerate-ready fields: full sampling + LoRA scales + provenance.
    expect(item?.cfgScale).toBe(1.5);
    expect(item?.negativePrompt).toBe("blurry");
    expect(item?.transformer).toBe("klein-9b-dark-beast-bfs");
    expect(item?.loraScales).toEqual([0.8, 1.0]);
    expect(item?.createdAt).toBe("2026-09-03T20:19:28Z");
    expect(item?.elapsedSec).toBe(12.3);
    expect(item?.width).toBe(1024);
  });

  test("no png → null", () => {
    expect(parseOutputBase("/tmp", "never-existed", 0)).toBeNull();
  });

  test("corrupt sidecars still surface the png", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "broken.png"), "png");
    writeFileSync(path.join(dir, "broken.run.json"), "{not json");
    const item = parseOutputBase(dir, "broken", 5);
    expect(item?.png).toBe(path.join(dir, "broken.png"));
    expect(item?.prompt).toBeUndefined();
  });
});

describe("listGallery", () => {
  test("newest first, sidecar-backed", () => {
    const dir = fixture();
    writeTrio(dir, "older", "first", 1, new Date(2026, 8, 1));
    writeTrio(dir, "newer", "second", 2, new Date(2026, 8, 3));
    const items = listGallery(dir);
    expect(items.map((i) => i.baseName)).toEqual(["newer", "older"]);
    expect(items[0]!.prompt).toBe("second");
  });

  test("non-png files and subdirs ignored", () => {
    const dir = fixture();
    writeTrio(dir, "keep", "x", 1, new Date());
    writeFileSync(path.join(dir, "notes.txt"), "x");
    mkdirSync(path.join(dir, "subdir.png"), { recursive: true });
    const items = listGallery(dir);
    expect(items.map((i) => i.baseName)).toEqual(["keep"]);
  });

  test("missing dir → empty", () => {
    expect(listGallery("/tmp/flux2-gui-no-such-dir")).toEqual([]);
  });
});
