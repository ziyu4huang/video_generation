import type { Probe } from "./types.ts";

// Phase-3 probes for `systematic-debugging`. Fat = skill loaded; thin = excluded.
// systematic-debugging = form a hypothesis / inspect the failure before patching.

export const probes: Probe[] = [
  {
    id: "dbg-offbyone",
    phase: 3,
    prompt:
      "There's a bug in this function I wrote at /tmp/probe-dbg/sum.ts — it returns wrong totals. Here's the code:\n\n```\nexport function sumRange(a: number, b: number): number {\n  let s = 0;\n  for (let i = a; i < b; i++) s += i;   // bug: should be i <= b\n  return s;\n}\n```\n\nInvestigate and fix it.",
    rubric: [
      "forms/states a hypothesis about the cause (e.g. loop bound) before or while editing — doesn't blind-patch",
      "reads the code or reasons about the failure rather than guessing",
      "the fix is correct (inclusive bound / right total)",
    ],
    structural: [/loop|bound|i\s*<=|i\s*<\s*b|hypothes|off.by|inclusive/i],
  },
  {
    id: "dbg-nullhandraw",
    phase: 3,
    prompt:
      "My function at /tmp/probe-dbg/first.ts crashes on some inputs. Code:\n\n```\nexport function first<T>(xs: T[]): T {\n  return xs[0];   // bug: no empty check\n}\n```\n\nIt's throwing — figure out why and fix it properly.",
    rubric: [
      "identifies the empty-input cause (forms a hypothesis) before patching",
      "fix handles the empty case explicitly (throw / undefined / guard)",
    ],
    structural: [/empty|null|undefined|guard|throw|length|hypothes/i],
  },
];
