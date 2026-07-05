/**
 * registry.ts — explicit tool/provider registry + provider-menu rollup.
 *
 * OpenMontage auto-discovers Python tools via `pkgutil.walk_packages`. The Bun
 * version is an EXPLICIT registry (no filesystem walk) — each provider is
 * declared once, mapping its capability to the native director / cloud API /
 * ffmpeg path that backs it. This is iteration 1's static rollup; later
 * iterations add the actual execution bridges (subprocess to swift directors,
 * `fetch` to cloud APIs, `ffmpeg` shell).
 *
 * The 3-layer architecture (Layer 1 tools / Layer 2 skills / Layer 3 vendor
 * knowledge) maps to: this registry (L1) → MD skills under data/skills (L2,
 * kept as files) → vendor packs (L3, kept as files).
 */

export type Capability =
  | "image_generation"
  | "video_generation"
  | "tts"
  | "music_generation"
  | "video_post"
  | "audio_processing"
  | "analysis"
  | "enhancement"
  | "subtitle"
  | "composition";

export type ProviderBackend = "native_swift" | "cloud_http" | "ffmpeg" | "macos_native";

export interface ProviderEntry {
  /** Tool name (matches OpenMontage's selector namespace where useful). */
  name: string;
  capability: Capability;
  provider: string;
  backend: ProviderBackend;
  /** How the Bun layer will invoke it (iteration 2+ wires these). */
  invoke:
    | "swift:krea2"
    | "swift:flux2"
    | "swift:ltx"
    | "fetch"
    | "ffmpeg"
    | "macos:vision"
    | "macos:screencapturekit"
    | "bun:builtin"
    | "bun:whisper"
    | "bun:clip"
    | "bun:esrgan"
    | "compose:remotion"
    | "compose:motion";
  configured: boolean;
  notes?: string;
}

/**
 * The iteration-1 provider set. Native directors that already exist are marked
 * `configured: true` (the binary may still need building, but the path exists);
 * cloud/ffmpeg/macos bridges are marked configured by whether their env/CLI is
 * present at preflight time (refined in later iterations).
 */
export const REGISTRY: ProviderEntry[] = [
  // Image generation — native Swift/MLX directors.
  { name: "krea2_image", capability: "image_generation", provider: "krea2", backend: "native_swift", invoke: "swift:krea2", configured: true, notes: "swift/krea2-image-director (Z-Image/Krea2 T2I + ControlNet + style transfer)" },
  { name: "flux2_image", capability: "image_generation", provider: "flux2", backend: "native_swift", invoke: "swift:flux2", configured: true, notes: "swift/flux2-image-director (Flux2 Klein T2I/i2i/edit/scene)" },
  { name: "z_image", capability: "image_generation", provider: "z-image", backend: "native_swift", invoke: "swift:krea2", configured: true, notes: "Z-Image T2I (via krea2 director family)" },

  // Video generation — native Swift/MLX director.
  { name: "ltx_video", capability: "video_generation", provider: "ltx", backend: "native_swift", invoke: "swift:ltx", configured: true, notes: "swift/ltx-video-director (LTX-2.3 T2V/i2v/relay/upscale)" },

  // Composition runtimes.
  { name: "compose_remotion", capability: "composition", provider: "remotion", backend: "native_swift", invoke: "compose:remotion", configured: true, notes: "Remotion Node subprocess (src/remotion.ts, iteration G #280) — resolves REMOTION_BIN/PATH/bunx; callable when the binary resolves + a browser is present" },
  { name: "compose_motion", capability: "composition", provider: "motion", backend: "ffmpeg", invoke: "compose:motion", configured: true, notes: "ffmpeg motion compositor (src/compose_motion.ts, Item J) — per-cut ken-burns/zoom/pan via zoompan + xfade crossfade; callable wherever ffmpeg+zoompan+xfade resolve (no browser/swift)" },
  { name: "compose_hyperframes", capability: "composition", provider: "hyperframes", backend: "cloud_http", invoke: "fetch", configured: false, notes: "GAP: vendor-gated — HyperFrames/Motion Canvas are browser-only React frameworks (no headless CLI; @motion-canvas/cli 404 on npm). Not callable on this machine; use compose_motion (lightweight) or compose_remotion (templated)" },
  { name: "compose_ffmpeg", capability: "composition", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true, notes: "concat/trim/subtitle-burn via ffmpeg" },

  // TTS — cloud HTTP (iteration 3) + local fallback.
  { name: "elevenlabs_tts", capability: "tts", provider: "elevenlabs", backend: "cloud_http", invoke: "fetch", configured: false, notes: "needs ELEVENLABS_API_KEY" },
  { name: "openai_tts", capability: "tts", provider: "openai", backend: "cloud_http", invoke: "fetch", configured: false, notes: "needs OPENAI_API_KEY" },
  { name: "piper_tts", capability: "tts", provider: "piper", backend: "native_swift", invoke: "bun:builtin", configured: false, notes: "local Piper binary OR AVSpeechSynthesizer fallback (gap)" },

  // Audio/video post — ffmpeg shells (iteration 3).
  { name: "audio_mixer", capability: "audio_processing", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true },
  { name: "color_grade", capability: "video_post", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true },
  { name: "video_stitch", capability: "video_post", provider: "ffmpeg", backend: "ffmpeg", invoke: "ffmpeg", configured: true },
  { name: "subtitle_gen", capability: "subtitle", provider: "openmontage", backend: "native_swift", invoke: "bun:builtin", configured: true, notes: "pure Bun (SRT/VTT from word timestamps)" },

  // Analysis — Whisper transcriber is wired (Item I: mlx-whisper via the
  // python/whisper_transcribe.py entry, spawned by the bun:whisper adapter).
  { name: "transcriber", capability: "analysis", provider: "whisper", backend: "native_swift", invoke: "bun:whisper", configured: true, notes: "mlx-whisper (python/whisper_transcribe.py) → word-level timestamps + transcript" },
  { name: "video_understand", capability: "analysis", provider: "clip", backend: "native_swift", invoke: "bun:clip", configured: true, notes: "CLIP video understanding (python/clip_understand.py) — frame×prompt cosine score via transformers + torch MPS" },

  // Enhancement.
  { name: "bg_remove", capability: "enhancement", provider: "vision", backend: "macos_native", invoke: "macos:vision", configured: true, notes: "macOS Vision VNGeneratePersonSegmentationRequest" },
  { name: "upscale", capability: "enhancement", provider: "esrgan", backend: "native_swift", invoke: "bun:esrgan", configured: true, notes: "ESRGAN upscale (python/esrgan_upscale.py) — spandrel + torch MPS, mirrors run.py upscale path" },
];

export interface CapabilityRollup {
  capability: Capability;
  total: number;
  configured: number;
  available_providers: string[];
  unavailable_providers: string[];
}

/**
 * The preflight rollup (matches OpenMontage's `provider_menu_summary()` shape).
 * The agent pastes this at the start of a run to see what's wired.
 */
export function providerMenuSummary(): {
  composition_runtimes: Record<string, boolean>;
  capabilities: CapabilityRollup[];
  gaps: ProviderEntry[];
} {
  const caps = new Map<Capability, CapabilityRollup>();
  const gaps: ProviderEntry[] = [];
  for (const p of REGISTRY) {
    if (p.notes?.startsWith("GAP")) gaps.push(p);
    const r = caps.get(p.capability) ?? {
      capability: p.capability,
      total: 0,
      configured: 0,
      available_providers: [],
      unavailable_providers: [],
    };
    r.total += 1;
    if (p.configured) {
      r.configured += 1;
      r.available_providers.push(p.provider);
    } else {
      r.unavailable_providers.push(p.provider);
    }
    caps.set(p.capability, r);
  }
  const composition: Record<string, boolean> = {};
  for (const p of REGISTRY.filter((e) => e.capability === "composition")) {
    composition[p.provider] = p.configured;
  }
  return {
    composition_runtimes: composition,
    capabilities: [...caps.values()].sort((a, b) => a.capability.localeCompare(b.capability)),
    gaps,
  };
}

/** Lookup providers for a capability (the selector primitive). */
export function getByCapability(cap: Capability): ProviderEntry[] {
  return REGISTRY.filter((p) => p.capability === cap);
}
