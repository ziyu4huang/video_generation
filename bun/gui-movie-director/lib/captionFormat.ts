/**
 * Shared normalization for `.caption.json` files written by `run.py caption`.
 *
 * Current on-disk format stores multiple VLM styles per image/video:
 *   { image|video, model, updated_style, styles: { [style]: { model, elapsed_sec, caption } } }
 *
 * Legacy files (pre multi-style) are flat single-style records:
 *   { image|video, style, model, elapsed_sec, caption }
 * These are migrated in-memory on read — never rewritten on disk by the
 * reader, only by `run.py caption` itself when it next regenerates a style.
 */

export interface CaptionStyleEntry {
  model?: string;
  elapsed_sec?: number;
  caption: unknown;
}

export interface NormalizedCaptionFile {
  image?: string;
  video?: string;
  model?: string;
  updated_style?: string;
  styles: Record<string, CaptionStyleEntry>;
}

export function normalizeCaptionFile(raw: any): NormalizedCaptionFile | null {
  if (!raw || typeof raw !== "object") return null;

  if (raw.styles && typeof raw.styles === "object") {
    return {
      image: raw.image,
      video: raw.video,
      model: raw.model,
      updated_style: raw.updated_style,
      styles: raw.styles,
    };
  }

  // Legacy flat format: guess the style key from its own `style` field.
  const style = raw.style || "default";
  return {
    image: raw.image,
    video: raw.video,
    model: raw.model,
    updated_style: style,
    styles: {
      [style]: {
        model: raw.model,
        elapsed_sec: raw.elapsed_sec,
        caption: raw.caption,
      },
    },
  };
}

export function pickCaptionStyle(
  file: NormalizedCaptionFile | null | undefined,
  style: string
): { style: string; model?: string; elapsed_sec?: number; caption: unknown } | null {
  const entry = file?.styles?.[style];
  if (!entry) return null;
  return { style, model: entry.model, elapsed_sec: entry.elapsed_sec, caption: entry.caption };
}
