/**
 * commands.ts — authoritative map of every `krea2` subcommand to its typed
 * parameters + CLI-flag translation.
 *
 * SINGLE source of truth for the tool's command surface. Curated against
 * `swift/krea2-image-director/Sources/Krea2ImageDirectorCLI/<Cmd>Command.swift`
 * and verified by `scripts/check-flags.ts` (run `krea2 <cmd> --help` and assert
 * every declared flag is modeled here or allow-listed).
 *
 * Naming: Swift `@Option var cfgScale` → CLI `--cfg-scale` (camelCase→kebab).
 * Defaults are intentionally NOT duplicated — `buildArgs` only emits a flag when
 * the agent sets a value, so the Swift default always wins. This avoids drift.
 */
import { Type, type TSchema } from "typebox";

export type FieldType = "string" | "number" | "int" | "boolean" | "string[]" | "number[]";

export interface FieldSpec {
  /** CLI flag including dashes, e.g. "--prompt", "--seed". Use "" for positional. */
  flag: string;
  type: FieldType;
  description: string;
  /** Value is a filesystem path → path-validated against allowed roots. */
  isPath?: boolean;
  /** Array field where every element is a path. */
  isPathArray?: boolean;
  /**
   * Value is a bare NAME the Swift binary joins onto a models-tree root
   * itself, NOT a path the tool resolves. The Swift side does this join with
   * NO '..'-sanitization, so this field must be validated as a bare path
   * component (no separators, no ".." segments).
   */
  isPathComponent?: boolean;
  /** Positional argument (no flag prefix), appended in declared order. */
  positional?: boolean;
  /**
   * For string[]/number[] fields whose CLI flag takes ONE joined value rather
   * than a repeated flag. Set to the join separator (e.g. ",").
   */
  joinWith?: string;
}

export interface CommandSpec {
  /** CLI subcommand name, e.g. "t2i". */
  name: string;
  /** True if the command produces an image output parseable from stdout. */
  writesImage: boolean;
  /** One-line "when to use" for the dispatcher description. */
  when: string;
  fields: Record<string, FieldSpec>;
}

// ─── Field schemas → typebox ─────────────────────────────────────────────────

function fieldSchema(f: FieldSpec): TSchema {
  const wrap = (t: TSchema): TSchema => Type.Optional(t);
  switch (f.type) {
    case "string":
      return wrap(Type.String({ description: f.description }));
    case "number":
      return wrap(Type.Number({ description: f.description }));
    case "int":
      return wrap(Type.Integer({ description: f.description }));
    case "boolean":
      return wrap(Type.Boolean({ description: f.description }));
    case "string[]":
      return wrap(Type.Array(Type.String(), { description: f.description }));
    case "number[]":
      return wrap(Type.Array(Type.Number(), { description: f.description }));
  }
}

/** Build a typebox Type.Object for a command's parameters. */
export function buildParams(spec: CommandSpec) {
  const props: Record<string, TSchema> = {};
  for (const [key, f] of Object.entries(spec.fields)) props[key] = fieldSchema(f);
  return Type.Object(props);
}

// ─── Reusable field blocks ───────────────────────────────────────────────────

/**
 * Shared Krea 2 generation fields. Unlike Flux2, Krea 2 takes NO --models-root
 * / --output-dir globals (weights + default output dir resolve internally via
 * Paths.swift) and exposes the Turbo-specific timestep-shift `--mu`.
 */
const GEN_FIELDS = {
  width: { flag: "--width", type: "int", description: "Output width (px, multiple of 16). Default 1024." },
  height: { flag: "--height", type: "int", description: "Output height (px, multiple of 16). Default 1024." },
  steps: { flag: "--steps", type: "int", description: "Denoise steps (Turbo: 8). Default 8." },
  seed: { flag: "--seed", type: "int", description: "Random seed. Default 42." },
  mu: { flag: "--mu", type: "number", description: "Timestep-shift mu (Turbo: 1.15). Default 1.15." },
  out: { flag: "--out", type: "string", isPath: true, description: "Output PNG path. Omit = auto `krea2_<cmd>_s<seed>.png` in the output dir." },
} satisfies Record<string, FieldSpec>;

// ─── The 2 krea2 subcommands ─────────────────────────────────────────────────

export const COMMANDS: Record<string, CommandSpec> = {
  t2i: {
    name: "t2i",
    writesImage: true,
    when: "Text → image (native Swift Krea 2 Turbo MMDiT). The basic generation path.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt (multilingual via Qwen3 encoder)." },
      bridge: { flag: "--bridge", type: "boolean", description: "Use the Python MLX bridge instead of the native Swift engine (default: native)." },
      ...GEN_FIELDS,
    },
  },

  i2i: {
    name: "i2i",
    writesImage: true,
    when: "Image → image edit (native Swift, SDEditor-style). strength is the source-fidelity lever.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Input image path (PNG/JPG)." },
      prompt: { flag: "--prompt", type: "string", description: "Text prompt describing the edit." },
      strength: { flag: "--strength", type: "number", description: "Denoise strength 0..1 (how much to change). Low preserves the input, high follows the prompt. Default 0.6." },
      ...GEN_FIELDS,
    },
  },

  controlnet: {
    name: "controlnet",
    writesImage: true,
    when: "Control-image-guided generation via a Control LoRA (native Swift, Krea 2 Turbo). Requires an ALREADY preprocessed conditioning image (depth/pose/edge PNG) — this command does no canny/scribble/depth extraction itself, unlike the run.py bridge's `controlnet` action. Use when the caller already has a conditioning map in hand.",
    fields: {
      prompt: { flag: "--prompt", type: "string", description: "Text prompt." },
      controlImage: { flag: "--control-image", type: "string", isPath: true, description: "Control image path (depth/pose/edge PNG — preprocessed externally; no built-in canny/scribble/depth extraction)." },
      controlLora: { flag: "--control-lora", type: "string", isPath: true, description: "Control LoRA safetensors path (Patil/Krea-2-depth-controlnet). Omit to use the promoted/staging default." },
      strength: { flag: "--strength", type: "number", description: "Control strength 0..1 (how strongly the control image guides generation). Default 1.0." },
      channelMode: { flag: "--channel-mode", type: "string", description: "Channel mode: rgb or gray (grayscale recommended for depth). Default gray." },
      normalize: { flag: "--normalize", type: "string", description: "Normalize: none or minmax (per-image min-max; recommended for depth). Default minmax." },
      invert: { flag: "--invert", type: "boolean", description: "Invert the control image (1 - x)." },
      ...GEN_FIELDS,
    },
  },
};

// ─── Args builder ────────────────────────────────────────────────────────────

function fmtScalar(f: FieldSpec, v: number | string): string {
  return f.type === "number" || f.type === "int" ? String(v) : String(v);
}

/**
 * Translate a typed options object into a krea2 CLI token list, in the order
 * fields are declared. Only emits flags for keys that are present (!== undefined).
 * Path validation is the caller's responsibility (see pathFieldKeys).
 */
export function buildArgs(spec: CommandSpec, options: Record<string, unknown>): string[] {
  const args: string[] = [];
  const positionalBuf: string[] = [];
  for (const [key, f] of Object.entries(spec.fields)) {
    if (!(key in options)) continue;
    const v = options[key];
    if (v === undefined || v === null) continue;

    if (f.type === "boolean") {
      if (v === true) {
        if (f.positional) throw new Error(`boolean positional field "${key}" is invalid`);
        args.push(f.flag);
      }
      continue;
    }

    if (f.positional) {
      if (Array.isArray(v)) {
        for (const item of v) positionalBuf.push(String(item));
      } else {
        positionalBuf.push(String(v));
      }
      continue;
    }

    if (f.type === "string[]" || f.type === "number[]") {
      if (!Array.isArray(v)) {
        throw new Error(`field "${key}" expects an array, got ${typeof v}`);
      }
      if (f.joinWith != null) {
        args.push(f.flag, v.map((item) => fmtScalar(f, item)).join(f.joinWith));
      } else {
        for (const item of v) args.push(f.flag, fmtScalar(f, item));
      }
      continue;
    }

    // scalar string / number / int
    args.push(f.flag, fmtScalar(f, v as number | string));
  }
  // Positionals go last.
  return [...args, ...positionalBuf];
}

/** Keys of path-typed fields (for pre-flight path validation). */
export function pathFieldKeys(spec: CommandSpec): string[] {
  return Object.entries(spec.fields)
    .filter(([, f]) => f.isPath || f.isPathArray)
    .map(([k]) => k);
}

/** All flag names this command models (for the check-flags drift guard). */
export function modeledFlags(spec: CommandSpec): string[] {
  return Object.values(spec.fields)
    .filter((f) => !f.positional && f.flag)
    .map((f) => f.flag);
}

/** Command display list for the tool description. */
export const COMMAND_LIST = Object.values(COMMANDS);
