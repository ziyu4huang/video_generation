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
  if (f.compact !== undefined) out.compact = f.compact;
  if (f.visible !== undefined) out.visible = f.visible;
  if (f.multiline !== undefined) out.multiline = f.multiline;
  // `hint` was authored on UnifiedField and read by CommandForm, but this
  // whitelist never copied it — so `field.hint` on the UI side was ALWAYS
  // undefined and no hint ever rendered. purify's resolution hint (which warns
  // that seedvr2 at 2x/2160 can hard-crash the GPU, exit 134) was invisible for
  // its whole life. Verified before the fix: toSections(purifyCommand) dropped
  // the one authored hint. This is a copy-whitelist, so a NEW UnifiedField
  // property is silently dropped the same way unless it is added here —
  // schemas/toForm.test.ts now pins that every authored hint survives.
  if (f.hint !== undefined) out.hint = f.hint;
  if (f.control === "select" && f.choices) out.options = f.choices;
  if (f.control === "select" && f.choicesFrom) out.choicesFrom = f.choicesFrom;
  if (f.control === "loras" && f.loraTags) out.loraTags = f.loraTags;
  return out;
}
