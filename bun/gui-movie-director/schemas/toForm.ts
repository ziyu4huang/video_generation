import type { UnifiedCommand, UnifiedField } from "./types";

export function toSections(cmd: UnifiedCommand) {
  const sectionMap = new Map<string, Record<string, any>[]>();
  for (const f of cmd.fields) {
    if (!f.section) continue;
    if (!sectionMap.has(f.section)) sectionMap.set(f.section, []);
    sectionMap.get(f.section)!.push(fieldToUi(f));
  }
  return {
    action: cmd.action,
    submitLabel: cmd.submitLabel,
    runningLabel: cmd.runningLabel,
    isDisabled: cmd.isDisabled ?? (() => false),
    sections: [...sectionMap.entries()].map(([title, fields]) => ({ title, fields })),
    ...(cmd.buildParams && { buildParams: cmd.buildParams }),
  };
}

function fieldToUi(f: UnifiedField): Record<string, any> {
  const out: Record<string, any> = { type: f.control, key: f.key };
  if (f.label !== undefined) out.label = f.label;
  if (f.required !== undefined) out.required = f.required;
  if (f.placeholder !== undefined) out.placeholder = f.placeholder;
  if (f.default !== undefined) out.default = f.default;
  if (f.min !== undefined) out.min = f.min;
  if (f.max !== undefined) out.max = f.max;
  if (f.step !== undefined) out.step = f.step;
  if (f.visible !== undefined) out.visible = f.visible;
  if (f.multiline !== undefined) out.multiline = f.multiline;
  if (f.control === "select" && f.choices) out.options = f.choices;
  return out;
}
