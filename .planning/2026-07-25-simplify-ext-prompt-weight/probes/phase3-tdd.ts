import type { Probe } from "./types.ts";

// Phase-3 probes for `test-driven-development`. Fat = skill loaded; thin = excluded.
// Print mode (`pi -p`) is one-shot, so rubric checks the WORK (test-first) not
// interactivity. All file ops target /tmp so the repo tree stays clean.

export const probes: Probe[] = [
  {
    id: "tdd-clamp",
    phase: 3,
    prompt:
      "Add a `clamp(n, lo, hi)` function (returns n clamped to [lo,hi]) to /tmp/probe-tdd/clamp.ts. Include its tests.",
    rubric: [
      "writes a test (file or block) BEFORE or alongside the implementation, not after-thought",
      "the implementation is correct (clamp returns lo when n<lo, hi when n>hi, else n)",
    ],
    structural: [/test|spec|expect|assert|bun:test/i, /clamp/i],
  },
  {
    id: "tdd-leapyear",
    phase: 3,
    prompt:
      "Add `isLeapYear(y)` (true for leap years: divisible by 4, not 100 unless 400) to /tmp/probe-tdd/date.ts with tests.",
    rubric: [
      "writes a test before/with the implementation (test-first intent)",
      "implementation handles the 100/400 edge case correctly",
    ],
    structural: [/test|spec|expect|assert|bun:test/i, /isLeapYear|leap/i],
  },
];
