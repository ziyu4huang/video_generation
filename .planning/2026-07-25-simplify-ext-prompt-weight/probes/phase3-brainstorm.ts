import type { Probe } from "./types.ts";

// Phase-3 probes for `brainstorming`. Fat = skill loaded; thin = excluded.
// Print mode is one-shot (can't ask interactive Qs), so rubric checks whether
// the agent EXPLORES intent/requirements/tradeoffs in prose before committing
// to an implementation — the core brainstorming instinct.

export const probes: Probe[] = [
  {
    id: "brainstorm-ratelimiter",
    phase: 3,
    prompt: "Let's build a rate limiter for our API.",
    rubric: [
      "explores requirements or asks clarifying questions in prose BEFORE proposing code (what kind of limiter? per-user? limits? storage?)",
      "does not immediately dump a full implementation without surfacing a decision or assumption",
    ],
    structural: [/require|consider|tradeoff|question|option|approach|clarif|assume/i],
  },
  {
    id: "brainstorm-settings",
    phase: 3,
    prompt: "I want to add a settings page to the app.",
    rubric: [
      "surfaces scope/intent questions before coding (which settings? persistence? UI?)",
      "proposes a design or decision-point rather than jumping straight to code",
    ],
    structural: [/require|consider|tradeoff|question|option|approach|clarif|assume|design/i],
  },
];
