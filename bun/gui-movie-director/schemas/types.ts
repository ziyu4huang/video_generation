export type ControlType =
  | "prompt" | "text" | "number" | "range"
  | "select" | "toggle" | "image" | "images";

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
};

export interface UnifiedField {
  key: string;
  cliFlag?: string;
  control: ControlType;
  label?: string;
  required?: boolean;
  default?: any;
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  section?: string;
  visible?: (s: Record<string, any>) => boolean;
  multiline?: boolean;
}

export interface UnifiedCommand {
  action: string;
  submitLabel: string;
  runningLabel: string;
  fields: UnifiedField[];
  isDisabled?: (s: Record<string, any>) => boolean;
  buildParams?: (s: Record<string, any>) => Record<string, any>;
}
