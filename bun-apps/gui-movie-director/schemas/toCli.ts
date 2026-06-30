import type { UnifiedCommand, CliType } from "./types";
import { CONTROL_TO_CLI } from "./types";

export interface CliField {
  type: CliType;
  cliFlag: string;
  required?: boolean;
  default?: any;
  choices?: string[];
  min?: number;
  max?: number;
  isPath?: boolean;
}

export function toCliFields(cmd: UnifiedCommand): Record<string, CliField> {
  const result: Record<string, CliField> = {};
  for (const f of cmd.fields) {
    if (!f.cliFlag) continue;
    const field: CliField = {
      type: CONTROL_TO_CLI[f.control],
      cliFlag: f.cliFlag,
    };
    if (f.required !== undefined) field.required = f.required;
    if (f.default !== undefined) field.default = f.default;
    if (f.choices) field.choices = f.choices.map((c) => c.value);
    else if (f.choicesFrom) field.choices = []; // dynamic choices (loaded from run.py at runtime)
    if (f.min !== undefined) field.min = f.min;
    if (f.max !== undefined) field.max = f.max;
    // Image/file-upload controls always carry a server filesystem path —
    // flag for path-containment validation in buildCliArgs.
    if (f.control === "image") field.isPath = true;
    result[f.key] = field;
  }
  return result;
}
