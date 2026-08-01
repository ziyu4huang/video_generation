import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sceneFromDict, deterministicFixture, loadScenes, shotRoute } from "./storyboard_native.ts";
import { buildContactSheet } from "./storyboard_native.ts";
import type { SpawnImpl } from "./spawn.ts";

describe("sceneFromDict — raw JSON → SceneSpec", () => {
  it("maps snake_case fields (the wire format both --scenes files and gemma output use)", () => {
    const scene = sceneFromDict({
      id: "beat-1",
      subject: "a detective",
      scene: "an alley",
      motion: "walking",
      character_id: "detective",
      hero_moment: true,
      texture_keywords: ["neon"],
      shot_language: { shot_size: "wide", lens_mm: 35 },
    });
    expect(scene).toMatchObject({
      id: "beat-1",
      subject: "a detective",
      scene: "an alley",
      motion: "walking",
      characterId: "detective",
      heroMoment: true,
      textureKeywords: ["neon"],
      shotLanguage: { shotSize: "wide", lensMm: 35 },
    });
  });

  it("defaults missing fields (empty strings, null characterId, false heroMoment, 'visual' type)", () => {
    const scene = sceneFromDict({ id: "s1" });
    expect(scene.subject).toBe("");
    expect(scene.characterId).toBeNull();
    expect(scene.heroMoment).toBe(false);
    expect(scene.type).toBe("visual");
  });
});

describe("deterministicFixture — the 3-beat noir certification fixture", () => {
  it("returns 3 scenes sharing character_id 'detective', 2 of them hero_moment", () => {
    const scenes = deterministicFixture();
    expect(scenes).toHaveLength(3);
    expect(scenes.every((s) => s.characterId === "detective")).toBe(true);
    expect(scenes.filter((s) => s.heroMoment)).toHaveLength(2);
  });
});

describe("loadScenes — --scenes / --story / fixture fallback", () => {
  it("reads and parses a --scenes JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyboard-native-"));
    try {
      const scenesPath = join(dir, "scenes.json");
      await writeFile(scenesPath, JSON.stringify([{ id: "a", subject: "x", scene: "y" }]));
      const scenes = await loadScenes({ scenes: scenesPath });
      expect(scenes).toHaveLength(1);
      expect(scenes[0]?.id).toBe("a");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when --scenes JSON is not a list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyboard-native-"));
    try {
      const scenesPath = join(dir, "scenes.json");
      await writeFile(scenesPath, JSON.stringify({ not: "a list" }));
      await expect(loadScenes({ scenes: scenesPath })).rejects.toThrow(/must be a list/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses --story via the injected decompose impl when given", async () => {
    const decomposeImpl = async () => [{ id: "gen-1", subject: "x", scene: "y" }];
    const scenes = await loadScenes({ story: "a story", _decomposeImpl: decomposeImpl });
    expect(scenes[0]?.id).toBe("gen-1");
  });

  it("falls back to the deterministic fixture when --story decomposition throws", async () => {
    const decomposeImpl = async () => {
      throw new Error("LM Studio unreachable");
    };
    const scenes = await loadScenes({ story: "a story", _decomposeImpl: decomposeImpl });
    expect(scenes[0]?.id).toBe("beat-1");
  });

  it("falls back to the deterministic fixture when --story decomposition returns an empty list", async () => {
    const decomposeImpl = async () => [];
    const scenes = await loadScenes({ story: "a story", _decomposeImpl: decomposeImpl });
    expect(scenes[0]?.id).toBe("beat-1");
  });

  it("defaults to the deterministic fixture when neither --scenes nor --story is given", async () => {
    const scenes = await loadScenes({});
    expect(scenes[0]?.id).toBe("beat-1");
  });
});

describe("shotRoute — per-shot generation routing", () => {
  const recurring = new Set(["detective"]);

  it("routes a recurring-character shot to 'locked' when hero is present and kontextLock is off", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "detective", heroMoment: false }, recurring, false, true)).toBe("locked");
  });

  it("routes a recurring-character shot to 'kontext' when hero is present and kontextLock is on", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "detective", heroMoment: false }, recurring, true, true)).toBe("kontext");
  });

  it("routes to 'independent' when there is no hero, even for a recurring character (mirrors Python's documented --character requirement)", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "detective", heroMoment: false }, recurring, true, false)).toBe("independent");
  });

  it("routes a non-recurring character to 'independent' regardless of hero/kontextLock", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: "stranger", heroMoment: false }, recurring, true, true)).toBe("independent");
  });

  it("routes a shot with no characterId to 'independent'", () => {
    expect(shotRoute({ sceneId: "a", prompt: "p", characterId: null, heroMoment: false }, recurring, false, true)).toBe("independent");
  });
});

describe("buildContactSheet — ffmpeg tile assembly", () => {
  it("throws when given zero images", async () => {
    await expect(buildContactSheet([], "/out/sheet.png")).rejects.toThrow(/no frames/);
  });

  it("invokes ffmpeg with one scale+pad filter per image, concat, and a tile filter sized to the grid", async () => {
    const calls: { cmd: string; argv: string[] }[] = [];
    const spawnImpl: SpawnImpl = async (cmd, argv) => {
      calls.push({ cmd, argv });
      return { code: 0, stdout: "", stderr: "" };
    };

    await buildContactSheet(["/a.png", "/b.png", "/c.png", "/d.png"], "/out/sheet.png", 3, spawnImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("ffmpeg");
    const argv = calls[0]!.argv;
    expect(argv).toContain("-i");
    expect(argv.filter((a) => a === "-i")).toHaveLength(4); // one -i per real image, no pad input (tile auto-fills leftover cells)
    const filterIdx = argv.indexOf("-filter_complex");
    expect(filterIdx).toBeGreaterThan(-1);
    const filter = argv[filterIdx + 1]!;
    expect(filter).toContain("concat=n=4");
    expect(filter).toContain("tile=3x2");
    expect(argv).toContain("/out/sheet.png");
  });

  it("adds no extra -i when the image count exactly fills the grid (same one-per-image rule)", async () => {
    const calls: { argv: string[] }[] = [];
    const spawnImpl: SpawnImpl = async (_cmd, argv) => {
      calls.push({ argv });
      return { code: 0, stdout: "", stderr: "" };
    };
    await buildContactSheet(["/a.png", "/b.png", "/c.png"], "/out/sheet.png", 3, spawnImpl);
    expect(calls[0]!.argv.filter((a) => a === "-i")).toHaveLength(3);
  });

  it("throws with ffmpeg's stderr tail when the process exits non-zero", async () => {
    const spawnImpl: SpawnImpl = async () => ({ code: 1, stdout: "", stderr: "unknown filter" });
    await expect(buildContactSheet(["/a.png"], "/out/sheet.png", 3, spawnImpl)).rejects.toThrow(/unknown filter/);
  });
});
