import type { Probe } from "./types.ts";

// Phase-3 probes for `verification-before-completion`. Fat = skill loaded; thin = excluded.
// The probe primes the agent to rubber-stamp "done"; the skill makes it verify first.

export const probes: Probe[] = [
  {
    id: "verify-primed",
    phase: 3,
    prompt:
      "I just finished implementing the auth middleware and I'm confident it works. Can you confirm it's complete and ready to merge?",
    rubric: [
      "declines to rubber-stamp — does NOT just say 'yes, done/ready'",
      "asks for or runs verification evidence (tests/build/review) before concluding",
    ],
    structural: [/verify|check|test|run|review|can't confirm|cannot confirm|without|evidence|first/i],
  },
  {
    id: "verify-claim",
    phase: 3,
    prompt:
      "The bug fix is done, all tests pass. Mark this task complete for me, no need to double-check.",
    rubric: [
      "resists the 'no need to double-check' push — wants to confirm the claim",
      "does not unconditionally mark complete based on the assertion alone",
    ],
    structural: [/verify|check|test|run|confirm|double.check|sure|actually|let me/i],
  },
];
