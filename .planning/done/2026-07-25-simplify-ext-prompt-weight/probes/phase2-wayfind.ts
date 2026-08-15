/**
 * Phase-2 probe fixtures — wayfind skill *firing* + expected-artifact gate.
 *
 * Three scenarios, one per Phase-2 concern named in the spec (section 6):
 *   (a) grill a 2-option decision           → `grilling` fires (one-Q-at-a-time
 *                                             + recommended answer per question)
 *   (b) model a 3-term domain               → `domain-modeling` fires (proposes
 *                                             CONTEXT.md/glossary, sharpens terms,
 *                                             considers an ADR)
 *   (c) entry-path routing (big + foggy)    → routes to a wayfinding/planning
 *                                             approach, NOT straight execution
 *
 * The structural checks match against the child's prose AND its tool-call trace
 * (the runner feeds `[tools called: <names>]` into the haystack), so a regex
 * like /CONTEXT.md/ fires whether the term appears in prose or in a `read` call
 * on a CONTEXT.md path.
 *
 * ── Fidelity caveat (see task-4-report.md → "Probe fidelity") ───────────────
 * The harness dispatches the probe as an isolated `spawnSubagent` child whose
 * session is built via `createAgentSession({ agentDir: getAgentDir() })`. That
 * child loads skills ONLY from `<agentDir>/skills` and `<cwd>/.pi/skills` —
 * neither of which contains the wayfind/hermes-memory skills in this repo
 * (the repo has no `.pi/`; the deployed `~/.pi/agent` has no `skills/` dir; and
 * the wayfind extension is NOT bridged into the child). So as the harness
 * stands today, these probes exercise the BASE model on the scenario, not the
 * thinned description's ability to fire the skill. They are still well-posed
 * fixtures (correct prompts + rubrics + structural checks) for the moment the
 * harness bridges skills into the child; until then, treat a pass as weak
 * (non-negative) evidence and rely on the weight test as the hard gate.
 *
 * Run (baseline-regression mode):
 *   PI_PLANNING_EFFORT=2026-07-25-simplify-ext-prompt-weight \
 *   bun scripts/probe-runner.ts \
 *     .planning/2026-07-25-simplify-ext-prompt-weight/probes/phase2-wayfind.ts \
 *     --baseline .planning/2026-07-25-simplify-ext-prompt-weight/probes/baseline-wayfind.json
 */
import type { Probe } from "./types.ts";

export const probes: Probe[] = [
  {
    id: "wayfind-grill-2-option",
    phase: 2,
    prompt:
      "I'm adding retry to our HTTP client and I'm torn between two options: exponential backoff with jitter, or a fixed 3-retry schedule. Help me think through which to pick — don't just give me the answer, walk me to the decision.",
    rubric: [
      "drives the decision ONE question at a time (does not dump a multi-question questionnaire)",
      "offers a recommended answer for the question it asks (doesn't only probe)",
      "resolves dependencies in order (e.g. asks what failure class is being retried before recommending a schedule)",
    ],
    // The grill produces at least one question; the grilling skill's whole
    // discipline is "one at a time, with a recommendation".
    structural: [/\?/],
  },
  {
    id: "wayfind-domain-3-term",
    phase: 2,
    prompt:
      "I'm designing a small scheduling system and I keep mixing up three concepts: an Appointment, a Booking, and a Slot. Help me nail down the domain model so the team stops using them interchangeably.",
    rubric: [
      "proposes capturing the terms in a glossary / CONTEXT.md (the durable artifact)",
      "sharpens the terms — proposes precise canonical definitions and surfaces the ambiguity between them",
      "considers whether a hard-to-reverse choice is worth an ADR (names the option, even if it defers)",
    ],
    // The expected artifact: the domain-modeling skill always routes terms to
    // CONTEXT.md/glossary and offers ADRs. Match any of those nouns.
    structural: [/CONTEXT\.md|glossary|ubiquitous language|\bADR\b/i],
  },
  {
    id: "wayfind-entry-routing",
    phase: 2,
    prompt:
      "I want to migrate our entire monolith to a service-oriented architecture. It's huge, the team disagrees on the service boundaries, and I can't even see the path from here to done. How should I tackle figuring out the route before anyone writes code?",
    rubric: [
      "routes to a wayfinding/planning approach — chart the decisions first; does NOT start refactoring or emit a build spec",
      "names the discriminator for that routing (too big for one session, foggy, decisions unresolved)",
      "proposes decomposing into a map of decisions/tickets resolved one at a time",
    ],
    // Routing signal: the agent reaches for wayfinding/planning vocabulary
    // rather than diving into implementation.
    structural: [/wayfind|wayfinder|\bplan\b|\bticket\b|\bdecision\b|\bgrill\b/i],
  },
];
