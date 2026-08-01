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
 * docs/superpowers/specs/2026-08-01-storyboard-native-port-design.md):
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
import { join } from "node:path";
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
