/**
 * character_lock.ts — the cross-image CHARACTER CONSISTENCY planner.
 *
 * OM's stated #1 challenge is "identity anchored verbatim across shots" — render
 * the SAME character across N independent scene images. MLX already has every
 * primitive (Flux2KleinEdit reference conditioning, seed-locking, multi-view
 * profile, trained LoRA via import-lora-image) but NO persistent identity lock
 * across separate generations. This module is the local character-lock OM's
 * asset-directors assume exists (Step 2 of next-goal-20260708-080000).
 *
 * This is a DETERMINISTIC PLANNER, not a generator. Given a hero image + a lock
 * spec + a list of scene prompts, it emits (a) a reusable `IdentitySpec` (the
 * persistent identity-bank entry — the locked seed/CFG/ref/LoRA/style params +
 * the hero reference) and (b) one `RunPyImageOptions` per shot, each carrying
 * the SAME lock so every shot conditions on the hero with identical params. The
 * per-shot generation itself runs through the mlx:runpy-image adapter
 * (runpy_image.ts) against the EXISTING run.py ref-conditioning surface — zero
 * new MLX generation code (the same "wiring not new code" thesis as Step 1).
 *
 * The recipe + its honest limits are documented in
 * `docs/character-consistency-recipe.md`. Summary of the stack:
 *   1. SEED LOCK — same seed every shot (the cheapest, most reliable lever;
 *      image-profile already locks seed across views for exactly this reason).
 *   2. REFERENCE CONDITIONING — Flux2KleinEdit --ref-count / --ref-strength on
 *      the hero. SOFT identity influence, not a true embedding.
 *   3. STYLE/PALETTE ANCHOR — a shared prompt suffix (the `styleAnchor`) so the
 *      look holds even when the scene changes.
 *   4. (strongest, optional) TRAINED CHARACTER LoRA — via import-lora-image; the
 *      only lever that approaches a true identity embedding on local silicon.
 *
 * LOCAL ONLY (constraint 1): every shot's options name only local run.py
 * params; the model is a local transformer. Never a cloud GAI / IP-adapter API.
 */
import type { RunPyImageOptions } from "./runpy_image.ts";

/** The locked parameters applied identically to every shot (the identity lock). */
export interface CharacterLock {
  /** Pipeline family. flux2-klein (default) is the only one with ref conditioning. */
  pipeline?: "flux2-klein" | "zimage" | "lens";
  /** Locked base seed — applied to every shot (the #1 consistency lever). */
  seed: number;
  /** Locked CFG scale (optional; kept constant across shots when set). */
  cfgScale?: number;
  /** Flux2KleinEdit reference-conditioning copies (1 fast … 3 strongest). Default 3. */
  refCount?: number;
  /** Reference conditioning strength (0–1; None = mflux default). */
  refStrength?: number;
  /** Optional trained character LoRA path (the strongest identity lever). */
  loraPath?: string;
  /** LoRA scale (default 1.0). */
  loraScale?: number;
  /**
   * Shared prompt suffix appended to every shot (the style/palette anchor). Keeps
   * the LOOK consistent across scenes even when composition changes.
   */
  styleAnchor?: string;
}

/** One scene shot — a scene-specific prompt carrying the full character lock. */
export interface CharacterShot {
  /** Stable shot id (caller-supplied or auto `shot-<i>`). */
  id: string;
  /** The scene-specific prompt (the lock's styleAnchor is appended automatically). */
  prompt: string;
  /** The locked run.py invocation for this shot (action:i2i, hero as reference). */
  options: RunPyImageOptions;
}

/**
 * The persistent identity spec — the local "character-reference-bank" entry.
 * Persist this JSON alongside the hero; reuse it for any future shot of the same
 * character by feeding it back to planCharacterShots (or generating ad-hoc).
 */
export interface IdentitySpec {
  /** Schema version (forward-compat for the identity-bank format). */
  schema: "character-lock.v1";
  /** Hero image path — the canonical reference for this character. */
  hero: string;
  /** The locked params (seed/ref/LoRA/style). */
  lock: CharacterLock;
  /** The planned shots, each carrying the full lock. */
  shots: CharacterShot[];
}

export interface PlanCharacterShotsInput {
  /** Hero image path (the identity anchor / reference-bank entry). Required. */
  hero: string;
  /** The lock applied to every shot. */
  lock: CharacterLock;
  /** The scene prompts to render (each becomes one shot). */
  scenes: Array<{ id?: string; prompt: string }>;
}

/** Default lock values when the caller omits them (mirrors image-profile's proven defaults). */
const DEFAULT_LOCK = {
  pipeline: "flux2-klein" as const,
  refCount: 3,
  refStrength: 0.8,
  loraScale: 1.0,
};

/**
 * Build the per-shot run.py option set for one scene under the lock.
 *
 * Each shot uses action:"i2i" with the hero as BOTH the input image and the
 * reference image, at HIGH denoise (the scene is new) — identity is preserved by
 * Flux2KleinEdit reference conditioning (ref-count/ref-strength) + the locked
 * seed + the style anchor, NOT by low-denoise editing. This mirrors the
 * anime2real/profile mechanism (Flux2KleinEdit ref + LoRA) generalized to
 * arbitrary scene prompts. Pure function — unit-testable, no generation.
 */
export function shotOptionsFor(
  hero: string,
  lock: CharacterLock,
  scenePrompt: string,
): RunPyImageOptions {
  const anchor = lock.styleAnchor?.trim();
  const prompt = anchor ? `${scenePrompt.trim()}, ${anchor}` : scenePrompt.trim();
  return {
    action: "i2i",
    pipeline: lock.pipeline ?? DEFAULT_LOCK.pipeline,
    prompt,
    // Hero anchors identity: it is the image to refine AND the reference to condition on.
    inputImage: hero,
    referenceImage: hero,
    seed: lock.seed,
    cfgScale: lock.cfgScale,
    // High denoise = the scene is genuinely new; identity comes from ref conditioning,
    // not from preserving the hero's composition. (Low denoise would just edit the hero.)
    denoiseStrength: 0.85,
    loraPath: lock.loraPath,
    loraScale: lock.loraPath ? (lock.loraScale ?? DEFAULT_LOCK.loraScale) : undefined,
  };
}

/**
 * Plan N character-consistent shots from a hero + lock + scene list. Returns the
 * reusable IdentitySpec. Throws if hero is empty or no scenes are given.
 *
 * NOTE: refCount/refStrength are part of the lock but are NOT in RunPyImageOptions
 * (the i2i ref-conditioning strength is run.py-internal). They ride on the spec so
 * the caller can pass them via extraArgs (the run.py image i2i path honors
 * --ref-count / --ref-strength) — see optionsForShotWithExtraArgs below.
 */
export function planCharacterShots(input: PlanCharacterShotsInput): IdentitySpec {
  if (!input.hero || !input.hero.trim()) {
    throw new Error("planCharacterShots: hero (image path) is required");
  }
  if (!input.scenes || input.scenes.length === 0) {
    throw new Error("planCharacterShots: at least one scene is required");
  }
  const lock: CharacterLock = {
    pipeline: input.lock.pipeline ?? DEFAULT_LOCK.pipeline,
    seed: input.lock.seed,
    cfgScale: input.lock.cfgScale,
    refCount: input.lock.refCount ?? DEFAULT_LOCK.refCount,
    refStrength: input.lock.refStrength ?? DEFAULT_LOCK.refStrength,
    loraPath: input.lock.loraPath,
    loraScale: input.lock.loraScale ?? (input.lock.loraPath ? DEFAULT_LOCK.loraScale : undefined),
    styleAnchor: input.lock.styleAnchor,
  };
  const shots: CharacterShot[] = input.scenes.map((s, i) => ({
    id: s.id?.trim() || `shot-${i + 1}`,
    prompt: s.prompt,
    options: shotOptionsFor(input.hero, lock, s.prompt),
  }));
  return { schema: "character-lock.v1", hero: input.hero, lock, shots };
}

/**
 * The extraArgs a caller appends to a shot's run.py invocation to apply the
 * ref-conditioning strength/count (run.py image i2i honors --ref-count /
 * --ref-strength). Both are in the EXTRA_ARG_ALLOW_RUNPY_IMAGE allowlist.
 */
export function refCondExtraArgs(lock: CharacterLock): string[] {
  const args: string[] = [];
  if (lock.refCount != null) args.push("--ref-count", String(lock.refCount));
  if (lock.refStrength != null) args.push("--ref-strength", String(lock.refStrength));
  return args;
}
