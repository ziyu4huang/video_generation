export type FieldDef =
  | { type: "prompt"; key: string; required?: boolean; placeholder?: string; visible?: (state: Record<string, any>) => boolean }
  | { type: "text"; key: string; label: string; placeholder?: string; multiline?: boolean; visible?: (state: Record<string, any>) => boolean }
  | { type: "number"; key: string; label: string; min?: number; max?: number; step?: number; default?: number; visible?: (state: Record<string, any>) => boolean }
  | { type: "range"; key: string; label: string; min?: number; max?: number; step?: number; default?: number; visible?: (state: Record<string, any>) => boolean }
  | { type: "select"; key: string; label: string; options: { value: string; label: string }[]; default?: string; visible?: (state: Record<string, any>) => boolean }
  | { type: "toggle"; key: string; label: string; default?: boolean; visible?: (state: Record<string, any>) => boolean }
  | { type: "image"; key: string; label: string; required?: boolean; visible?: (state: Record<string, any>) => boolean }
  | { type: "images"; key: string; label: string; visible?: (state: Record<string, any>) => boolean };

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
