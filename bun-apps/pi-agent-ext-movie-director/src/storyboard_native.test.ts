import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sceneFromDict, deterministicFixture, loadScenes, shotRoute } from "./storyboard_native.ts";
import { buildContactSheet } from "./storyboard_native.ts";
import { runStoryboardNative, writeStoryboardJson, type SceneSpec, type T2iFn, type EditFn, type KontextFn } from "./storyboard_native.ts";
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

function noContactSheet(): SpawnImpl {
  return async () => ({ code: 0, stdout: "", stderr: "" });
}

describe("runStoryboardNative — the core orchestration (mocked scenes + generation)", () => {
  const fixedScenes: SceneSpec[] = [
    { id: "beat-1", subject: "detective", scene: "alley", characterId: "detective", heroMoment: true },
    { id: "beat-2", subject: "detective", scene: "diner", characterId: "detective" },
    { id: "beat-3", subject: "a stranger", scene: "rooftop", characterId: "stranger" },
  ];

  it("routes independent/locked/kontext shots to the right generation impl and assembles frames", async () => {
    const t2iCalls: string[] = [];
    const editCalls: string[] = [];
    const t2iImpl: T2iFn = async (p) => {
      t2iCalls.push(p.prompt);
      return { path: `/out/${p.prompt.slice(0, 4)}-t2i.png` };
    };
    const editImpl: EditFn = async (p) => {
      editCalls.push(p.prompt);
      return { path: `/out/${p.prompt.slice(0, 4)}-edit.png` };
    };

    const result = await runStoryboardNative({
      scenesOverride: fixedScenes,
      character: "/hero.png",
      outputDir: "/out",
      _t2iImpl: t2iImpl,
      _editImpl: editImpl,
      _spawnImpl: noContactSheet(),
    });

    expect(t2iCalls).toHaveLength(1); // the "stranger" shot (not recurring)
    expect(editCalls).toHaveLength(2); // the two "detective" shots (recurring, no kontextLock)
    expect(result.frames).toHaveLength(3);
    expect(result.frames.find((f) => f.sceneId === "beat-1")?.characterLocked).toBe(true);
    expect(result.frames.find((f) => f.sceneId === "beat-3")?.characterLocked).toBe(false);
    expect(result.recurringCharacters).toEqual(["detective"]);
  });

  it("routes recurring shots to kontext when kontextLock is set, with a distinct seed per kontext shot", async () => {
    const kontextSeeds: number[] = [];
    const kontextImpl: KontextFn = async (p) => {
      kontextSeeds.push(p.seed);
      return { path: "/out/k.png" };
    };

    await runStoryboardNative({
      scenesOverride: fixedScenes,
      character: "/hero.png",
      kontextLock: true,
      seed: 777,
      outputDir: "/out",
      _kontextImpl: kontextImpl,
      _t2iImpl: async () => ({ path: "/out/t2i.png" }),
      _spawnImpl: noContactSheet(),
    });

    expect(kontextSeeds).toEqual([777, 778]); // base_seed + index within the kontext-routed shots
  });

  it("keeps a failed shot's image as null and continues the run (no fail-fast, unlike Python)", async () => {
    const t2iImpl: T2iFn = async () => ({ path: null });
    const result = await runStoryboardNative({
      scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
      outputDir: "/out",
      _t2iImpl: t2iImpl,
      _spawnImpl: noContactSheet(),
    });
    expect(result.frames[0]?.image).toBeNull();
  });

  it("skips the contact sheet entirely when every shot fails (nothing to tile)", async () => {
    const spawnCalls: string[][] = [];
    const result = await runStoryboardNative({
      scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
      outputDir: "/out",
      _t2iImpl: async () => ({ path: null }),
      _spawnImpl: async (_cmd, argv) => {
        spawnCalls.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(spawnCalls).toHaveLength(0);
    expect(result.contactSheet).toBeNull();
  });

  it("uses the deterministic fixture when scenesOverride is omitted and no --scenes/--story is given", async () => {
    const result = await runStoryboardNative({
      outputDir: "/out",
      _t2iImpl: async () => ({ path: "/out/t2i.png" }),
      _editImpl: async () => ({ path: "/out/edit.png" }),
      _spawnImpl: noContactSheet(),
    });
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0]?.sceneId).toBe("beat-1");
  });

  it("derives outDir/contactSheet from a generated frame's directory when outputDir is omitted", async () => {
    const result = await runStoryboardNative({
      scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
      _t2iImpl: async () => ({ path: "/generated/elsewhere/s1.png" }),
      _spawnImpl: noContactSheet(),
    });
    expect(result.outDir).toBe("/generated/elsewhere");
    expect(result.contactSheet).toBe("/generated/elsewhere/contact_sheet.png");
  });

  it("falls back to '.' when outputDir is omitted and every shot fails (nothing to derive a dir from)", async () => {
    const result = await runStoryboardNative({
      scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
      _t2iImpl: async () => ({ path: null }),
      _spawnImpl: noContactSheet(),
    });
    expect(result.outDir).toBe(".");
    expect(result.contactSheet).toBeNull();
  });
});

describe("writeStoryboardJson", () => {
  it("writes storyboard.json with a trailing newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storyboard-native-"));
    try {
      const result = await runStoryboardNative({
        scenesOverride: [{ id: "s1", subject: "x", scene: "y" }],
        outputDir: dir,
        _t2iImpl: async () => ({ path: "/out/t2i.png" }),
        _spawnImpl: noContactSheet(),
      });
      const path = await writeStoryboardJson(dir, result);
      expect(path).toBe(join(dir, "storyboard.json"));
      const { readFile: rf } = await import("node:fs/promises");
      const raw = await rf(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw).frames).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
