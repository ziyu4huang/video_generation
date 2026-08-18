export type ControlType =
  | "prompt" | "text" | "number" | "range"
  | "select" | "toggle" | "image" | "images" | "loras" | "multiselect";

export type CliType = "string" | "number" | "boolean" | "select" | "multiselect";

export const CONTROL_TO_CLI: Record<ControlType, CliType> = {
  prompt: "string",
  text: "string",
  number: "number",
  range: "number",
  select: "select",
  toggle: "boolean",
  image: "string",
  images: "multiselect",
  loras: "multiselect",      // UI-only (no cliFlag → never reaches toCliFields); defensive
  multiselect: "multiselect", // backend-only list fields (e.g. lora_path/lora_scale)
};

/** Extra context a dynamic `hint` can read (see UnifiedField.hint). */
export interface HintContext {
  /** Dimensions of the currently loaded input image, or null when none is set. */
  inputDims: { w: number; h: number } | null;
}

export interface UnifiedField {
  key: string;
  cliFlag?: string;
  control: ControlType;
  label?: string;
  required?: boolean;
  default?: any;
  choices?: { value: string; label: string; group?: string }[];
  // Dynamic choices: when set, the select's options come from serverDefaults[<key>]
  // (fetched from run.py via /api/schema-defaults) instead of the static `choices`
  // array. Used for the T2I Transformer dropdown (choicesFrom: "transformers"), so
  // the list always reflects models/transformer/* on disk — never hardcoded here.
  choicesFrom?: string;
  min?: number;
  max?: number;
  step?: number;
  compact?: boolean;
  placeholder?: string;
  section?: string;
  visible?: (s: Record<string, any>) => boolean;
  multiline?: boolean;
  /**
   * Secondary text rendered under the control (the `field-hint` span).
   *
   * A function receives the current form state plus the loaded image's
   * dimensions, so a field can describe what its value will actually produce
   * (purify's resolution field previews the output size and warns about the
   * VRAM cliff). A plain string is the static case.
   *
   * This property was in use by CommandForm and by purify.ts BEFORE it existed
   * on this interface, and two schemas (video-compare, video-quality) instead
   * carried a `help:` string that NOTHING read — so their text never reached
   * the UI. Both are folded into this one property; there is no `help`.
   */
  hint?: string | ((s: Record<string, any>, ctx: HintContext) => string | undefined);
  // "loras" control only: static list of compatible LoRA manifest `pipeline`
  // tags, for commands with no user-facing pipeline picker (e.g. anime2real,
  // fixed to the flux2-klein-9b base model). Commands that DO have a
  // "pipeline" field (t2i, i2i) instead derive this dynamically from the
  // current pipeline selection via PIPELINE_TO_LORA_TAGS — see CommandForm.
  loraTags?: string[];
}

export interface UnifiedCommand {
  action: string;
  submitLabel: string;
  runningLabel: string;
  fields: UnifiedField[];
  isDisabled?: (s: Record<string, any>) => boolean;
  buildParams?: (s: Record<string, any>) => Record<string, any>;
}
