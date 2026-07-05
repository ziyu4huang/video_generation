/**
 * Explainer.tsx — the data-driven templated composition.
 *
 * Layers (back → front):
 *   0. solid background (theme palette)
 *   1. visual scenes — one Sequence per cut (image w/ ken-burns/zoom/pan, video, or text)
 *      with manual crossfade transitions at sequence boundaries
 *   2. overlays — section_title Sequences
 *   3. audio — narration + music (music fades in/out, optional loop/offset)
 *
 * Asset resolution: the orchestrator stages every source (image/video/audio) it
 * validates into a per-render `--public-dir` and writes its RELATIVE name into
 * props. `resolveAsset` then maps that name through `staticFile()` (Remotion's
 * loader — `file://` is blocked by the headless browser's CSP). URLs / data:
 * URIs pass through untouched.
 */
import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useVideoConfig,
  useCurrentFrame,
} from "remotion";

// ─── props (mirror the orchestrator's RemotionProps in src/remotion.ts) ──────

export type Animation = "static" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "ken-burns";

export interface RemotionCut {
  id: string;
  source: string;
  in_seconds: number;
  out_seconds: number;
  type?: "media" | "text";
  animation?: Animation;
  text?: string;
  subtitle?: string;
  source_in_seconds?: number;
  backgroundColor?: string;
}

export interface RemotionOverlay {
  type: "section_title";
  in_seconds: number;
  out_seconds: number;
  text: string;
  subtitle?: string;
  accentColor?: string;
  position?: "top-left" | "bottom-center" | "center";
}

export interface RemotionAudio {
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

export interface ExplainerProps {
  cuts: RemotionCut[];
  overlays?: RemotionOverlay[];
  audio?: RemotionAudio;
  transition?: "none" | "crossfade";
  transitionSeconds?: number;
  theme?: "dark" | "light";
  fps?: number;
  width?: number;
  height?: number;
}

// ─── palette ─────────────────────────────────────────────────────────────────

const PALETTE = {
  dark: { bg: "#0F172A", text: "#F8FAFC", accent: "#22D3EE", surface: "#1E293B", muted: "rgba(255,255,255,0.7)" },
  light: { bg: "#FFFFFF", text: "#1F2937", accent: "#2563EB", surface: "#F9FAFB", muted: "rgba(0,0,0,0.6)" },
};

// ─── asset resolution ────────────────────────────────────────────────────────

function resolveAsset(src: string): string {
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:")) return src;
  // Strip any accidental file:// / leading slash, then resolve via Remotion's
  // public-dir loader. The orchestrator stages sources into --public-dir and
  // writes the bare relative name; staticFile() makes Remotion serve it.
  const clean = src.replace(/^file:\/\/\/?/, "").replace(/^\/+/, "");
  return staticFile(clean);
}

const VIDEO_EXT = [".mp4", ".mov", ".webm", ".avi", ".mkv"];
function isVideo(src: string): boolean {
  const l = src.toLowerCase();
  return VIDEO_EXT.some((e) => l.endsWith(e));
}

// ─── crossfade wrapper ───────────────────────────────────────────────────────

/**
 * Fades a child in over `xfFrames` at the head of the sequence and out over
 * `xfFrames` at the tail. `head`/`tail` let the caller suppress the fade at the
 * very first head and very last tail of the whole timeline (no neighbor to
 * cross into). This is the manual equivalent of @remotion/transitions slide/cross
 * without the extra dependency.
 */
const Crossfade: React.FC<{
  children: React.ReactNode;
  xfFrames: number;
  head: boolean;
  tail: boolean;
}> = ({ children, xfFrames, head, tail }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fin = head ? 1 : interpolate(frame, [0, xfFrames], [0, 1], { extrapolateRight: "clamp" });
  const fout = tail ? 1 : interpolate(frame, [durationInFrames - xfFrames, durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  return <AbsoluteFill style={{ opacity: Math.min(fin, fout) }}>{children}</AbsoluteFill>;
};

// ─── scenes ──────────────────────────────────────────────────────────────────

const ImageScene: React.FC<{ src: string; animation?: Animation }> = ({ src, animation }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeIn = interpolate(frame, [0, Math.min(fps, 12)], [0, 1], { extrapolateRight: "clamp" });
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  let scale = 1;
  let tx = 0;
  let ty = 0;
  switch (animation) {
    case "zoom-in": scale = 1 + progress * 0.18; break;
    case "zoom-out": scale = 1.18 - progress * 0.18; break;
    case "pan-left": scale = 1.15; tx = interpolate(progress, [0, 1], [40, -40]); break;
    case "pan-right": scale = 1.15; tx = interpolate(progress, [0, 1], [-40, 40]); break;
    case "ken-burns":
      scale = 1 + progress * 0.22;
      tx = interpolate(progress, [0, 1], [0, -25]);
      ty = interpolate(progress, [0, 1], [0, -15]);
      break;
    default: break; // static
  }
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      <Img
        src={resolveAsset(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          opacity: fadeIn,
          transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
        }}
      />
    </AbsoluteFill>
  );
};

const VideoScene: React.FC<{ src: string; startFrom?: number }> = ({ src, startFrom = 0 }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <OffthreadVideo
        src={resolveAsset(src)}
        startFrom={Math.round(startFrom * fps)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
        muted
      />
    </AbsoluteFill>
  );
};

const TextScene: React.FC<{ text: string; subtitle?: string; bg: string; fg: string; accent: string }> = ({ text, subtitle, bg, fg, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rise = interpolate(frame, [0, Math.min(fps, 18)], [40, 0], { extrapolateRight: "clamp" });
  const fade = interpolate(frame, [0, Math.min(fps, 12)], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 12%", opacity: fade }}>
      <div style={{ fontSize: 96, fontWeight: 800, color: fg, textAlign: "center", lineHeight: 1.1, transform: `translateY(${rise}px)`, borderBottom: `6px solid ${accent}`, paddingBottom: 24 }}>{text}</div>
      {subtitle ? <div style={{ marginTop: 28, fontSize: 40, color: accent, fontWeight: 600, textAlign: "center" }}>{subtitle}</div> : null}
    </AbsoluteFill>
  );
};

// ─── overlay ─────────────────────────────────────────────────────────────────

const SectionTitle: React.FC<{ overlay: RemotionOverlay; palette: typeof PALETTE.dark }> = ({ overlay, palette }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fin = interpolate(frame, [0, Math.min(fps, 12)], [0, 1], { extrapolateRight: "clamp" });
  const fout = interpolate(frame, [durationInFrames - Math.min(fps, 12), durationInFrames], [1, 0], { extrapolateLeft: "clamp" });
  const accent = overlay.accentColor || palette.accent;
  const pos = overlay.position || "top-left";
  const anchor =
    pos === "center" ? { top: "50%", left: "50%", transform: "translate(-50%,-50%)" }
    : pos === "bottom-center" ? { bottom: "12%", left: "50%", transform: "translateX(-50%)" }
    : { top: "10%", left: "8%" };
  return (
    <AbsoluteFill style={{ opacity: Math.min(fin, fout), pointerEvents: "none" }}>
      <div style={{ position: "absolute", ...anchor, maxWidth: "70%" }}>
        <div style={{ fontSize: 72, fontWeight: 800, color: palette.text, lineHeight: 1.1, textShadow: "0 4px 24px rgba(0,0,0,0.6)" }}>{overlay.text}</div>
        {overlay.subtitle ? <div style={{ marginTop: 14, fontSize: 34, fontWeight: 600, color: accent }}>{overlay.subtitle}</div> : null}
        <div style={{ marginTop: 18, width: 96, height: 6, background: accent, borderRadius: 3 }} />
      </div>
    </AbsoluteFill>
  );
};

// ─── main ────────────────────────────────────────────────────────────────────

export const Explainer: React.FC<ExplainerProps> = (props) => {
  const { cuts, overlays, audio, transition = "crossfade", transitionSeconds = 0.5, theme = "dark" } = props;
  const { fps, durationInFrames } = useVideoConfig();
  const palette = PALETTE[theme] ?? PALETTE.dark;
  const xfFrames = Math.max(1, Math.round(transitionSeconds * fps));
  const useXfade = transition === "crossfade" && cuts.length > 1;

  // Sort cuts by in_seconds for head/tail bookkeeping (head = first, tail = last).
  const ordered = [...cuts].sort((a, b) => a.in_seconds - b.in_seconds);

  return (
    <AbsoluteFill style={{ background: palette.bg }}>
      {ordered.map((cut, i) => {
        const from = Math.round(cut.in_seconds * fps);
        const duration = Math.max(1, Math.round((cut.out_seconds - cut.in_seconds) * fps));
        const isText = cut.type === "text" || (!isVideo(cut.source) && !!cut.text && cut.animation === undefined && cut.type === "text");
        const inner = isText ? (
          <TextScene text={cut.text || cut.id} subtitle={cut.subtitle} bg={cut.backgroundColor || palette.surface} fg={palette.text} accent={palette.accent} />
        ) : isVideo(cut.source) ? (
          <VideoScene src={cut.source} startFrom={cut.source_in_seconds ?? 0} />
        ) : (
          <ImageScene src={cut.source} animation={cut.animation} />
        );
        return (
          <Sequence key={cut.id} from={from} durationInFrames={duration}>
            {useXfade ? (
              <Crossfade xfFrames={xfFrames} head={i === 0} tail={i === ordered.length - 1}>{inner}</Crossfade>
            ) : inner}
          </Sequence>
        );
      })}

      {overlays?.map((ov, i) => {
        const from = Math.round(ov.in_seconds * fps);
        const duration = Math.max(1, Math.round((ov.out_seconds - ov.in_seconds) * fps));
        return (
          <Sequence key={`ov-${i}`} from={from} durationInFrames={duration}>
            <SectionTitle overlay={ov} palette={palette} />
          </Sequence>
        );
      })}

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
