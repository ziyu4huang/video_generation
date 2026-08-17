/**
 * storyboard_native.ts — native Bun port of `run.py image storyboard`'s core
 * generation line (`app/commands/image-storyboard.py`, 730 lines).
 *
 * image-storyboard.py's own docstring says generation "reuses the tested
 * `execute_generation` core (the same path t2i uses) — no new MLX generation
 * code": scene decomposition is a plain LM Studio HTTP call
 * (storyboard_decompose.ts), scene→shot planning is pure logic
 * (storyboard_scene.ts / storyboard_prompt.ts), and per-shot generation
 * routes onto already-native primitives:
 *   - independent shots  → krea2 `t2i` (Z-Image)
 *   - locked shots        → flux2 `edit` (soft character-lock, hero as the
 *                            sole multi-ref)
 *   - kontext-lock shots  → flux2 `kontext` (true in-context identity lock)
 *
 * Two documented deltas from the Python (not silently dropped — see
 * .planning/specs/2026-08-01-storyboard-native-port-design.md):
 *   - The Python's soft character-lock uses `denoise_strength=0.85` (partial
 *     SDEdit redraw on top of flux2-klein's reference conditioning). flux2's
 *     `edit` command has no denoise-strength knob (verified against
 *     commands.ts); this port uses pure multi-ref conditioning instead — the
 *     same identity-lock mechanism `profile_native.ts`/`character_native.ts`
 *     already rely on.
 *   - The Python batches all kontext-lock shots in an arc into ONE
 *     `Flux1Kontext` model load (the ~31GB load is the expensive part). The
 *     Swift `flux2 kontext` CLI has no multi-prompt-per-invocation mode, so
 *     this port calls it once per shot (N loads instead of 1) — a
 *     performance delta, not a functional one.
 *
 * DEFERRED (documented, not silently dropped): the `--judge` closed loop
 * (caption score + VLM identity verification + weak-frame regeneration) —
 * left on the `runpy_image` fallback path, same treatment `workflow_hybrid`
 * gives its own deferred stages.
 *
 * Unlike the Python (which raises `RuntimeError` and aborts the whole run on
 * one shot's generation failure), a failed shot here records `image: null`
 * and orchestration continues — matching the graceful-degradation
 * convention `character_native.ts`'s Phase 2 cutout loop already
 * established, a deliberate deviation from the Python's fail-fast behavior.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runFlux2 } from "@repo/pi-agent-ext-flux2";
import { runKrea2 } from "@repo/pi-agent-ext-krea2";
import { decomposeStory } from "./storyboard_decompose.ts";
import { planStoryboard, type SceneSpec, type Shot, type ShotLanguage } from "./storyboard_scene.ts";
import { runSpawn, type SpawnImpl } from "./spawn.ts";
import type { LmStudioChatOptions } from "./lmstudio.ts";

export type { SceneSpec, Shot, Storyboard, ShotLanguage } from "./storyboard_scene.ts";

// ── Scene sourcing ──────────────────────────────────────────────────────

/** Convert a raw JSON scene dict (from --scenes or gemma decomposition) into a SceneSpec (mirrors `_scene_from_dict`). Wire format is snake_case, matching the schema embedded in the decompose prompt and the --scenes file convention. */
export function sceneFromDict(d: Record<string, unknown>): SceneSpec {
  const sl = (d.shot_language ?? {}) as Record<string, unknown>;
  const shotLanguage: ShotLanguage = {
    lensMm: sl.lens_mm as number | undefined,
    depthOfField: sl.depth_of_field as string | undefined,
    shotSize: sl.shot_size as string | undefined,
    cameraMovement: sl.camera_movement as string | undefined,
    lightingKey: sl.lighting_key as string | undefined,
    colorTemperature: sl.color_temperature as string | undefined,
  };
  return {
    id: String(d.id ?? `scene-${(d as { _idx?: unknown })._idx ?? "?"}`),
    subject: String(d.subject ?? ""),
    scene: String(d.scene ?? ""),
    motion: String(d.motion ?? ""),
    framing: String(d.framing ?? ""),
    shotLanguage,
    textureKeywords: Array.isArray(d.texture_keywords) ? (d.texture_keywords as string[]) : [],
    characterId: (d.character_id as string | null | undefined) ?? null,
    heroMoment: !!d.hero_moment,
    type: String(d.type ?? "visual"),
  };
}

/** A 3-beat detective-noir storyboard with one recurring character (mirrors `_deterministic_fixture`). Certifies the pipeline without the gemma brain. */
export function deterministicFixture(): SceneSpec[] {
  const shot = (shotSize: string, lightingKey: string, lensMm: number): ShotLanguage => ({ shotSize, lightingKey, lensMm });
  return [
    {
      id: "beat-1",
      subject: "a weary detective in a trench coat",
      scene: "a rain-soaked alley at night",
      motion: "lighting a cigarette under a flickering lamp",
      shotLanguage: shot("wide", "low_key", 35),
      textureKeywords: ["neon reflections", "wet pavement", "cigarette smoke"],
      characterId: "detective",
      heroMoment: true,
    },
    {
      id: "beat-2",
      subject: "the same detective",
      scene: "a cramped diner booth",
      motion: "studying a case file across the table",
      shotLanguage: shot("medium", "tungsten_warm", 50),
      textureKeywords: ["steam from coffee", "scattered photographs"],
      characterId: "detective",
      heroMoment: false,
    },
    {
      id: "beat-3",
      subject: "the detective",
      scene: "the city rooftop at dawn",
      motion: "looking out over the skyline",
      shotLanguage: shot("medium_close", "blue_hour", 85),
      textureKeywords: ["wind-blown coat", "soft morning haze"],
      characterId: "detective",
      heroMoment: true,
    },
  ];
}

export interface LoadScenesOptions extends LmStudioChatOptions {
  scenes?: string;
  story?: string;
  numPanels?: number;
  styleHint?: string;
  /** Test seam: inject a canned decompose call so unit tests don't need a real LM Studio server. */
  _decomposeImpl?: typeof decomposeStory;
}

/** Resolve the scene list: --scenes JSON file, --story (gemma decomposition), or the deterministic fixture (mirrors `_load_scenes`). */
export async function loadScenes(opts: LoadScenesOptions): Promise<SceneSpec[]> {
  if (opts.scenes) {
    const raw: unknown = JSON.parse(await readFile(opts.scenes, "utf8"));
    if (!Array.isArray(raw)) {
      throw new Error(`--scenes JSON must be a list, got ${typeof raw}`);
    }
    return (raw as Record<string, unknown>[]).map(sceneFromDict);
  }
  if (opts.story) {
    const decompose = opts._decomposeImpl ?? decomposeStory;
    try {
      const raw = await decompose(opts.story, {
        numPanels: opts.numPanels ?? 4,
        styleHint: opts.styleHint,
        model: opts.model,
        apiUrl: opts.apiUrl,
        timeoutMs: opts.timeoutMs,
        _fetchImpl: opts._fetchImpl,
      });
      if (raw.length > 0) return raw.map(sceneFromDict);
    } catch {
      // fall through to the deterministic fixture — mirrors Python's broad except
    }
    return deterministicFixture();
  }
  return deterministicFixture();
}

// ── Shot routing ─────────────────────────────────────────────────────────

export type ShotRoute = "kontext" | "locked" | "independent";

/**
 * Decide one shot's render path (mirrors `_shot_route`, extended with an
 * explicit `hasHero` check — Python's own `--character` help text says
 * "without it, all shots are independent T2I").
 */
export function shotRoute(shot: Shot, recurringIds: Set<string>, kontextLock: boolean, hasHero: boolean): ShotRoute {
  if (hasHero && shot.characterId != null && recurringIds.has(shot.characterId)) {
    return kontextLock ? "kontext" : "locked";
  }
  return "independent";
}

// ── Generation impls (independent / locked / kontext) ──────────────────

export interface T2iParams {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  outputDir?: string;
}
export interface T2iResult {
  path: string | null;
}
export type T2iFn = (params: T2iParams) => Promise<T2iResult>;

/** Default independent-shot generation: native krea2 Z-Image t2i (mirrors the Python's default `zimage` pipeline). */
export const defaultT2i: T2iFn = async (p) => {
  const out = await runKrea2({
    command: "t2i",
    options: { prompt: p.prompt, seed: p.seed, width: p.width, height: p.height, steps: p.steps },
    outputDir: p.outputDir,
  });
  return { path: out.details.ok ? out.details.output : null };
};

export interface EditParams {
  prompt: string;
  images: string[];
  seed: number;
  width: number;
  height: number;
  steps: number;
  outputDir?: string;
}
export interface EditResult {
  path: string | null;
}
export type EditFn = (params: EditParams) => Promise<EditResult>;

/** Default soft-lock generation: native flux2 `edit` (multi-ref conditioning, hero as the sole reference). No denoise-strength knob — see module doc. */
export const defaultEdit: EditFn = async (p) => {
  const out = await runFlux2({
    command: "edit",
    options: { prompt: p.prompt, images: p.images, seed: p.seed, width: p.width, height: p.height, steps: p.steps },
    outputDir: p.outputDir,
  });
  return { path: out.details.ok ? out.details.output : null };
};

export interface KontextParams {
  input: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  outputDir?: string;
}
export interface KontextResult {
  path: string | null;
}
export type KontextFn = (params: KontextParams) => Promise<KontextResult>;

/** Default kontext-lock generation: native flux2 `kontext` (true in-context identity lock). One call per shot — no batched single-model-load, see module doc. */
export const defaultKontext: KontextFn = async (p) => {
  const out = await runFlux2({
    command: "kontext",
    options: { input: p.input, prompt: p.prompt, seed: p.seed, width: p.width, height: p.height },
    outputDir: p.outputDir,
  });
  return { path: out.details.ok ? out.details.output : null };
};

// ── Contact sheet ────────────────────────────────────────────────────────

const CONTACT_SHEET_CELL_W = 480;
const CONTACT_SHEET_CELL_H = 720; // matches the non-kontext default aspect (640x960)

/**
 * Tile frame PNGs into a contact-sheet grid via ffmpeg (mirrors
 * `_build_contact_sheet`'s PIL tiling, without adding an image-codec
 * dependency to this package). Each source is letterboxed into a fixed
 * CONTACT_SHEET_CELL_W x CONTACT_SHEET_CELL_H cell (ffmpeg's `concat`+`tile`
 * require identical frame dimensions, unlike PIL's variable-height row
 * packing) — a documented simplification, not a silent behavior change.
 * Trailing empty grid cells (when imagePaths.length isn't a multiple of
 * cols) are left to ffmpeg's `tile` filter, which fills any leftover cells
 * with black once it runs out of concat-ed frames — close to, but not
 * exactly, Python's (16,16,16) background canvas. No extra pad input is
 * added for this: `tile`'s auto-fill needs no source frame to draw from.
 */
export async function buildContactSheet(
  imagePaths: string[],
  outPath: string,
  cols = 3,
  spawnImpl: SpawnImpl = runSpawn,
): Promise<void> {
  if (imagePaths.length === 0) {
    throw new Error("buildContactSheet: no frames to build a contact sheet");
  }
  const rows = Math.ceil(imagePaths.length / cols);

  const argv: string[] = ["-y"];
  for (const p of imagePaths) argv.push("-i", p);

  const filter: string[] = [];
  const labels: string[] = [];
  imagePaths.forEach((_, i) => {
    filter.push(
      `[${i}:v]scale=${CONTACT_SHEET_CELL_W}:${CONTACT_SHEET_CELL_H}:force_original_aspect_ratio=decrease,` +
        `pad=${CONTACT_SHEET_CELL_W}:${CONTACT_SHEET_CELL_H}:(ow-iw)/2:(oh-ih)/2:color=0x101010[s${i}]`,
    );
    labels.push(`[s${i}]`);
  });
  filter.push(`${labels.join("")}concat=n=${imagePaths.length}:v=1:a=0[c]`);
  filter.push(`[c]tile=${cols}x${rows}[out]`);
  argv.push("-filter_complex", filter.join(";"));
  argv.push("-map", "[out]", "-frames:v", "1", outPath);

  const r = await spawnImpl("ffmpeg", argv);
  if (r.code !== 0) {
    throw new Error(`buildContactSheet: ffmpeg exited ${r.code}: ${r.stderr.slice(-500)}`);
  }
}

// ── The main orchestration ──────────────────────────────────────────────

export interface StoryboardOptions extends LoadScenesOptions {
  character?: string;
  kontextLock?: boolean;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  outputDir?: string;
  /** Test seam: bypass loadScenes entirely with a fixed scene list. */
  scenesOverride?: SceneSpec[];
  /** Test seam: inject a canned t2i call so unit tests don't need the krea2 binary. */
  _t2iImpl?: T2iFn;
  /** Test seam: inject a canned edit call so unit tests don't need the flux2 binary. */
  _editImpl?: EditFn;
  /** Test seam: inject a canned kontext call so unit tests don't need the flux2 binary. */
  _kontextImpl?: KontextFn;
  /** Test seam: inject a canned ffmpeg spawn so unit tests don't need a real ffmpeg. */
  _spawnImpl?: SpawnImpl;
}

export interface StoryboardFrame {
  sceneId: string;
  characterId: string | null;
  heroMoment: boolean;
  characterLocked: boolean;
  kontextLocked: boolean;
  prompt: string;
  image: string | null;
}

export interface StoryboardResult {
  outDir: string;
  contactSheet: string | null;
  hero: string | null;
  kontextLock: boolean;
  recurringCharacters: string[];
  frames: StoryboardFrame[];
}

/**
 * Run the storyboard core generation line: scene sourcing → planning →
 * per-shot routed generation → contact sheet (mirrors `run_storyboard`,
 * minus the `--judge` closed loop — see module doc). A shot generation
 * failure records `image: null` and the run continues (see module doc for
 * the deliberate deviation from Python's fail-fast behavior).
 */
export async function runStoryboardNative(opts: StoryboardOptions): Promise<StoryboardResult> {
  const scenes = opts.scenesOverride ?? (await loadScenes(opts));
  const storyboard = planStoryboard(scenes);
  const hero = opts.character ?? null;
  const kontextLock = !!opts.kontextLock && hero != null;
  const recurringIds = new Set(storyboard.recurringCharacters);

  const baseSeed = opts.seed ?? 777;
  const width = opts.width ?? 640;
  const height = opts.height ?? 960;
  const steps = opts.steps ?? 9;
  const kontextWidth = opts.width ?? 1024;
  const kontextHeight = opts.height ?? 1024;

  const t2i = opts._t2iImpl ?? defaultT2i;
  const edit = opts._editImpl ?? defaultEdit;
  const kontext = opts._kontextImpl ?? defaultKontext;

  const frames: StoryboardFrame[] = [];
  let kontextIndex = 0;
  for (const shot of storyboard.shots) {
    const route = shotRoute(shot, recurringIds, kontextLock, hero != null);
    let image: string | null = null;
    if (route === "independent") {
      const r = await t2i({ prompt: shot.prompt, seed: baseSeed, width, height, steps, outputDir: opts.outputDir });
      image = r.path;
    } else if (route === "locked") {
      const r = await edit({ prompt: shot.prompt, images: [hero as string], seed: baseSeed, width, height, steps, outputDir: opts.outputDir });
      image = r.path;
    } else {
      const r = await kontext({
        input: hero as string,
        prompt: shot.prompt,
        seed: baseSeed + kontextIndex,
        width: kontextWidth,
        height: kontextHeight,
        outputDir: opts.outputDir,
      });
      kontextIndex += 1;
      image = r.path;
    }
    frames.push({
      sceneId: shot.sceneId,
      characterId: shot.characterId,
      heroMoment: shot.heroMoment,
      characterLocked: route !== "independent",
      kontextLocked: route === "kontext",
      prompt: shot.prompt,
      image,
    });
  }

  const successfulImages = frames.map((f) => f.image).filter((p): p is string => p != null);
  // When outputDir isn't given, generation impls fall back to their own default
  // output dir (not cwd) — derive the same dir from a real generated frame
  // (mirrors character_native.ts's outDir fallback) so contact_sheet.png lands
  // next to the frames it tiles, instead of at an unrelated "." (cwd).
  const outDir = opts.outputDir ?? (successfulImages[0] ? dirname(successfulImages[0]) : ".");
  let contactSheet: string | null = null;
  if (successfulImages.length > 0) {
    const contactSheetPath = join(outDir, "contact_sheet.png");
    await buildContactSheet(successfulImages, contactSheetPath, 3, opts._spawnImpl);
    contactSheet = contactSheetPath;
  }

  return { outDir, contactSheet, hero, kontextLock, recurringCharacters: storyboard.recurringCharacters, frames };
}

/** Write storyboard.json to `<outDir>/storyboard.json` (mirrors Python's `json.dump(..., indent=2)` + trailing newline). Split out so the core orchestration stays pure/testable, mirroring `character_native.ts`'s `writeIdentitySpec`. */
export async function writeStoryboardJson(outDir: string, result: StoryboardResult): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, "storyboard.json");
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}
