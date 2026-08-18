/**
 * Secondary text under a control. A function form can describe what the current
 * value will produce; a string is the static case. Mirrors UnifiedField.hint —
 * `toForm.fieldToUi` copies the authored value across unchanged.
 */
export type Hint =
  | string
  | ((state: Record<string, any>, ctx: { inputDims: { w: number; h: number } | null }) => string | undefined);

export type FieldDef =
  | { type: "prompt"; key: string; required?: boolean; placeholder?: string; visible?: (state: Record<string, any>) => boolean }
  | { type: "text"; key: string; label: string; placeholder?: string; multiline?: boolean; visible?: (state: Record<string, any>) => boolean }
  | { type: "number"; key: string; label: string; min?: number; max?: number; step?: number; default?: number; placeholder?: string; compact?: boolean; visible?: (state: Record<string, any>) => boolean }
  | { type: "range"; key: string; label: string; min?: number; max?: number; step?: number; default?: number; visible?: (state: Record<string, any>) => boolean }
  | { type: "select"; key: string; label: string; options?: { value: string; label: string }[]; choicesFrom?: string; default?: string; hint?: Hint; visible?: (state: Record<string, any>) => boolean }
  | { type: "toggle"; key: string; label: string; default?: boolean; hint?: Hint; visible?: (state: Record<string, any>) => boolean }
  | { type: "image"; key: string; label: string; required?: boolean; visible?: (state: Record<string, any>) => boolean }
  | { type: "images"; key: string; label: string; visible?: (state: Record<string, any>) => boolean }
  | { type: "loras"; key: string; label: string; loraTags?: string[]; visible?: (state: Record<string, any>) => boolean };

export interface SectionDef {
  title: string;
  fields: FieldDef[];
}

export interface CommandSchema {
  action: string;
  submitLabel: string;
  runningLabel: string;
  isDisabled: (state: Record<string, any>) => boolean;
  sections: SectionDef[];
  buildParams?: (state: Record<string, any>) => Record<string, any>;
}
