/**
 * Story.tsx — the rich story composition (ticket 06).
 *
 * Extends Explainer's layered model (background → scenes w/ motion + crossfade →
 * overlays → audio) with two story-specific layers:
 *   • a per-cut **ParticleLayer** (sparkle / petal / firefly) — DOM + interpolate,
 *     seeded so renders are reproducible.
 *   • a global **WordPopCaption** layer — TikTok-style one-word-at-a-time captions
 *     driven by a `wordCues` prop derived from the whisper words.json.
 *
 * The scene primitives (ImageScene/VideoScene/TextScene/Crossfade), asset
 * resolution, and palette are imported from Explainer.tsx so the two compositions
 * never drift on motion/transition behavior — Story only adds the richness.
 *
 * Registered alongside Explainer in Root.tsx; selected via `edit.composition`
 * (src/remotion.ts parameterizes the compositionId it passes to `remotion render`).
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  interpolate,
  useVideoConfig,
  useCurrentFrame,
} from "remotion";
import {
  PALETTE,
  resolveAsset,
  isVideo,
  Crossfade,
  ImageScene,
  VideoScene,
  TextScene,
  type Animation,
} from "./Explainer";

// ─── props (mirrors src/remotion.ts StoryProps) ──────────────────────────────

export type ParticleType = "sparkle" | "petal" | "firefly" | "none";

export interface ParticleSpec {
  type: ParticleType;
  /** Particle count multiplier (0–1+); absolute count = round(density × base). */
  density?: number;
  /** Drift magnitude in px (0 = static twinkle, 30 = slow drift). */
  drift?: number;
}

export interface StoryCut {
  id: string;
  source?: string;
  in_seconds: number;
  out_seconds: number;
  type?: "media" | "text";
  animation?: Animation;
  text?: string;
  subtitle?: string;
  source_in_seconds?: number;
  backgroundColor?: string;
  /** Per-cut particle overlay. Omit / "none" for no particles. */
  particles?: ParticleSpec;
}

export interface WordCue {
  word: string;
  start: number;
  end: number;
}

export interface StoryAudio {
  narration?: { src: string; volume?: number };
  music?: {
    src: string;
    volume?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
    offsetSeconds?: number;
    loop?: boolean;
  };
}

export interface StoryProps {
  cuts: StoryCut[];
  overlays?: Array<{
    type: "section_title";
    in_seconds: number;
    out_seconds: number;
    text: string;
    subtitle?: string;
    accentColor?: string;
    position?: "top-left" | "bottom-center" | "center";
  }>;
  audio?: StoryAudio;
  /** Per-word cues (seconds) for the TikTok-style caption layer. */
  wordCues?: WordCue[];
  captionStyle?: "tiktok" | "none";
  transition?: "none" | "crossfade";
  transitionSeconds?: number;
  theme?: "dark" | "light";
  fps?: number;
  width?: number;
  height?: number;
}

// ─── deterministic PRNG (reproducible particle placement) ────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── particle layer ──────────────────────────────────────────────────────────

const PARTICLE_BASE_COUNT = 26;

const ParticleLayer: React.FC<{ spec: ParticleSpec; palette: typeof PALETTE.dark }> = ({ spec, palette }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const density = spec.density ?? 0.6;
  const drift = spec.drift ?? 20;
  const count = Math.max(0, Math.round(PARTICLE_BASE_COUNT * density));
  // Seed from the spec type so different cuts with the same type still vary.
  const seed = spec.type.length * 1009 + Math.round(density * 97) + Math.round(drift);
  const rnd = mulberry32(seed);
  const particles = Array.from({ length: count }, () => ({
    x: rnd() * 100, // %
    y0: rnd() * 100, // %
    size: 4 + rnd() * 10, // px
    phase: rnd() * durationInFrames,
    speed: 0.4 + rnd() * 0.8,
    hue: rnd(),
    spin: (rnd() - 0.5) * 2,
  }));

  if (spec.type === "none" || count === 0) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      {particles.map((p, i) => {
        if (spec.type === "sparkle") {
          // Twinkling stationary dots.
          const tw = interpolate(
            Math.sin((frame + p.phase) * 0.18 * p.speed),
            [-1, 1],
            [0, 1],
          );
          return (
            <div key={i} style={{
              position: "absolute",
              left: `${p.x}%`, top: `${p.y0}%`,
              width: p.size, height: p.size,
              borderRadius: "50%",
              background: "#FFFFFF",
              boxShadow: `0 0 ${p.size * 1.5}px rgba(255,255,255,${0.6 * tw})`,
              opacity: 0.3 + 0.7 * tw,
            }} />
          );
        }
        if (spec.type === "petal") {
          // Falling, rotating petals (rounded shapes drifting down).
          const fall = ((p.y0 + (frame * p.speed * (drift / 20)) * 0.4) % 110) - 5;
          const sway = Math.sin((frame + p.phase) * 0.05) * drift * 0.3;
          const rot = (frame * p.spin * 2 + p.phase) % 360;
          const color = p.hue > 0.5 ? "#FBCFE8" : "#FECDD3";
          return (
            <div key={i} style={{
              position: "absolute",
              left: `${p.x + sway * 0.1}%`, top: `${fall}%`,
              width: p.size * 1.3, height: p.size * 0.8,
              borderRadius: "60% 40% 60% 40%",
              background: color,
              opacity: 0.75,
              transform: `rotate(${rot}deg)`,
            }} />
          );
        }
        // firefly — drifting glowing dots with a slow pulse.
        const pulse = interpolate(Math.sin((frame + p.phase) * 0.1 * p.speed), [-1, 1], [0.15, 0.9]);
        const dx = Math.sin((frame + p.phase) * 0.03) * drift;
        const dy = Math.cos((frame + p.phase) * 0.025) * drift;
        return (
          <div key={i} style={{
            position: "absolute",
            left: `${p.x}%`, top: `${p.y0}%`,
            width: p.size, height: p.size,
            marginLeft: dx, marginTop: dy,
            borderRadius: "50%",
            background: "#FEF3C7",
            boxShadow: `0 0 ${p.size * 2.4}px rgba(253,224,71,${0.8 * pulse})`,
            opacity: pulse,
          }} />
        );
      })}
    </AbsoluteFill>
  );
};

// ─── word-pop caption layer ──────────────────────────────────────────────────

const WordPopCaption: React.FC<{ cues: WordCue[]; palette: typeof PALETTE.dark }> = ({ cues, palette }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps; // absolute seconds (this layer lives at the composition root)
  // The active cue = the last word whose start ≤ t and end ≥ t, else the most
  // recent word that started. Show one word at a time (TikTok-style).
  let active: WordCue | undefined;
  for (const c of cues) {
    if (t >= c.start && t <= c.end + 0.25) { active = c; break; }
    if (c.start <= t) active = c; // keep latest-started as fallback within the gap
    else break;
  }
  if (!active || t < active.start - 0.05 || t > active.end + 0.4) return null;
  const pop = interpolate(
    frame - Math.round(active.start * fps),
    [0, Math.round(0.08 * fps)],
    [0.6, 1],
    { extrapolateRight: "clamp" },
  );
  const fade = interpolate(
    frame,
    [Math.round(active.end * fps), Math.round((active.end + 0.35) * fps)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const word = active.word.trim();
  if (!word) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: Math.min(pop, fade) }}>
      <div style={{
        position: "absolute", bottom: "14%", left: "50%", transform: `translateX(-50%) scale(${pop})`,
        fontSize: 110, fontWeight: 900, color: "#FFFFFF",
        textShadow: "0 4px 18px rgba(0,0,0,0.85), 0 0 6px rgba(0,0,0,0.6)",
        padding: "6px 28px", borderRadius: 18,
        whiteSpace: "nowrap",
        borderBottom: `8px solid ${palette.accent}`,
      }}>
        {word}
      </div>
    </AbsoluteFill>
  );
};

// ─── main ────────────────────────────────────────────────────────────────────

export const Story: React.FC<StoryProps> = (props) => {
  const {
    cuts, overlays, audio, wordCues,
    captionStyle = "tiktok",
    transition = "crossfade", transitionSeconds = 0.5,
    theme = "dark",
  } = props;
  const { fps, durationInFrames } = useVideoConfig();
  const palette = PALETTE[theme] ?? PALETTE.dark;
  const xfFrames = Math.max(1, Math.round(transitionSeconds * fps));
  const useXfade = transition === "crossfade" && cuts.length > 1;
  const ordered = [...cuts].sort((a, b) => a.in_seconds - b.in_seconds);

  return (
    <AbsoluteFill style={{ background: palette.bg }}>
      {ordered.map((cut, i) => {
        const from = Math.round(cut.in_seconds * fps);
        const duration = Math.max(1, Math.round((cut.out_seconds - cut.in_seconds) * fps));
        const isText = cut.type === "text";
        const inner = isText ? (
          <TextScene text={cut.text || cut.id} subtitle={cut.subtitle} bg={cut.backgroundColor || palette.surface} fg={palette.text} accent={palette.accent} />
        ) : cut.source && isVideo(cut.source) ? (
          <VideoScene src={cut.source} startFrom={cut.source_in_seconds ?? 0} />
        ) : cut.source ? (
          <ImageScene src={cut.source} animation={cut.animation} />
        ) : (
          <AbsoluteFill style={{ background: palette.surface }} />
        );
        const particles = cut.particles && cut.particles.type !== "none" ? cut.particles : undefined;
        return (
          <Sequence key={cut.id} from={from} durationInFrames={duration}>
            {useXfade ? (
              <Crossfade xfFrames={xfFrames} head={i === 0} tail={i === ordered.length - 1}>
                {inner}
              </Crossfade>
            ) : inner}
            {particles && <ParticleLayer spec={particles} palette={palette} />}
          </Sequence>
        );
      })}

      {overlays?.map((ov, i) => {
        // Reuse Explainer's SectionTitle via a lightweight inline render is not
        // possible without exporting it; overlays are rare in story, so we render
        // a minimal title block here.
        const from = Math.round(ov.in_seconds * fps);
        const duration = Math.max(1, Math.round((ov.out_seconds - ov.in_seconds) * fps));
        const accent = ov.accentColor || palette.accent;
        return (
          <Sequence key={`ov-${i}`} from={from} durationInFrames={duration}>
            <AbsoluteFill style={{ pointerEvents: "none" }}>
              <div style={{ position: "absolute", top: "10%", left: "8%", maxWidth: "70%" }}>
                <div style={{ fontSize: 72, fontWeight: 800, color: palette.text, lineHeight: 1.1, textShadow: "0 4px 24px rgba(0,0,0,0.6)" }}>{ov.text}</div>
                {ov.subtitle ? <div style={{ marginTop: 14, fontSize: 34, fontWeight: 600, color: accent }}>{ov.subtitle}</div> : null}
                <div style={{ marginTop: 18, width: 96, height: 6, background: accent, borderRadius: 3 }} />
              </div>
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {captionStyle === "tiktok" && wordCues && wordCues.length > 0 && (
        <WordPopCaption cues={wordCues} palette={palette} />
      )}

      {audio?.narration?.src && <Audio src={resolveAsset(audio.narration.src)} volume={audio.narration.volume ?? 1} />}

      {audio?.music?.src && (
        <Audio
          src={resolveAsset(audio.music.src)}
          startFrom={Math.round((audio.music.offsetSeconds ?? 0) * fps)}
          loop={audio.music.loop ?? false}
          loopVolumeCurveBehavior="repeat"
          volume={(f) => {
            const base = audio.music!.volume ?? 0.12;
            const fin = interpolate(f, [0, (audio.music!.fadeInSeconds ?? 2) * fps], [0, base], { extrapolateRight: "clamp" });
            const fout = interpolate(f, [durationInFrames - (audio.music!.fadeOutSeconds ?? 3) * fps, durationInFrames], [base, 0], { extrapolateLeft: "clamp" });
            return Math.min(fin, fout);
          }}
        />
      )}
    </AbsoluteFill>
  );
};
