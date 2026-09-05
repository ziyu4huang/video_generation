/**
 * flux2Args.ts — build `flux2 t2i` / `flux2 upscale` CLI token lists from
 * typed UI params. Flag naming follows the Swift surface
 * (T2ICommand.swift / UpscaleCommand.swift; camelCase → kebab-case).
 *
 * Only emits a flag when the caller set a value, so the Swift default always
 * wins and cannot drift (same convention as s2-agent-ext-flux2 commands.ts).
 * Seed stays a STRING end-to-end: it is a UInt64 in Swift and may exceed
 * Number.MAX_SAFE_INTEGER.
 */

export interface LoraEntry {
  /** LoRA directory name under models/lora/. */
  name: string;
  /** Application strength (Swift Float; trailing entries default 1.0). */
  scale: number;
}

export interface T2IParams {
  prompt: string;
  negativePrompt?: string;
  transformer?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: string;
  lora?: LoraEntry[];
  strictGate?: boolean;
  output?: string;
  outputDir?: string;
  name?: string;
}

export interface UpscaleParams {
  input: string;
  model?: string;
  output?: string;
  tileSize?: number;
  tileOverlap?: number;
  noTile?: boolean;
}

const fmt = (v: number | string): string => String(v);

/** Emit `flag value` only when defined; arrays repeat the flag per element. */
function push(
  args: string[],
  flag: string,
  v: string | number | boolean | string[] | number[] | undefined,
): void {
  if (v === undefined || v === null || v === "") return;
  if (typeof v === "boolean") {
    if (v) args.push(flag);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) args.push(flag, fmt(item));
    return;
  }
  args.push(flag, fmt(v));
}

export function t2iArgs(p: T2IParams): string[] {
  if (!p.prompt || !p.prompt.trim()) throw new Error("prompt is required");
  const args = ["t2i", "--prompt", p.prompt];
  push(args, "--negative-prompt", p.negativePrompt);
  push(args, "--transformer", p.transformer);
  push(args, "--width", p.width);
  push(args, "--height", p.height);
  push(args, "--steps", p.steps);
  push(args, "--cfg-scale", p.cfgScale);
  push(args, "--seed", p.seed);
  if (p.lora?.length) {
    push(args, "--lora", p.lora.map((l) => l.name));
    push(args, "--lora-scale", p.lora.map((l) => l.scale));
  }
  push(args, "--strict-gate", p.strictGate);
  push(args, "--output", p.output);
  push(args, "--output-dir", p.outputDir);
  push(args, "--name", p.name);
  return args;
}

export function upscaleArgs(p: UpscaleParams): string[] {
  if (!p.input) throw new Error("input is required");
  const args = ["upscale", "--input", p.input];
  push(args, "--model", p.model);
  push(args, "--output", p.output);
  push(args, "--tile-size", p.tileSize);
  push(args, "--tile-overlap", p.tileOverlap);
  push(args, "--no-tile", p.noTile);
  return args;
}
