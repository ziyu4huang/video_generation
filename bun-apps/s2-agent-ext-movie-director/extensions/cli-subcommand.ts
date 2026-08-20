/**
 * CLI sub-command spec for s2-agent.
 *
 * Lets `s2-agent` expose the movie-director extension as a top-level
 * sub-command:
 *
 *   s2-agent cli movie <natural-language request...>
 *   s2-agent cli --model sonnet movie "produce a 30s ad: red sports car on coastal road"
 *
 * The movie tool is an instruction-driven video-production orchestrator
 * (idea → script → scene_plan → assets → edit → compose → publish, with
 * gate-enforced checkpoints). It consumes the native krea2/flux2/ltx directors
 * under the hood, so the CLI passes the user's request as a natural-language
 * task and lets the agent drive the orchestration via the `movie` tool.
 *
 * This file is dependency-free of s2-agent on purpose: the workspace dep
 * direction is s2-agent → s2-agent-ext-movie-director, so the spec is typed
 * with a local structurally-compatible interface (TS structural typing makes it
 * assignable to s2-agent's `ExtensionSubcommandSpec`). See
 * `bun-apps/s2-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension from "./movie-director.ts";

/** Local shape of s2-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

export const movieSubcommand: ExtensionSubcommandSpec = {
  name: "movie",
  summary: "headless video-production orchestrator (idea→script→assets→edit→compose via run.py)",
  details: `Usage:
  s2-agent cli movie <natural-language request...> [options]

The movie tool is an instruction-driven video-production orchestrator. It drives
the full pipeline — idea → script → scene_plan → assets → edit → compose →
publish — with gate-enforced checkpoints, consuming the native krea2/flux2/ltx
image+video directors under the hood. Give a natural-language production request
as positionals; the agent maps it onto the right orchestration steps.

Positionals are the request verbatim. Production-specific flags are NOT parsed by
the CLI. Two ways to pass them:
  1. Fold them into the request text: \`movie produce a 30s ad, red sports car,
     coastal road, golden hour, 3 scenes\`
  2. Use the \`--\` end-of-options separator to pass raw flags through verbatim:
       s2-agent cli movie -- produce --idea "..." --scenes 3
     Everything after \`--\` is appended to the request as-is.

This spends real GPU tokens (MLX image + video generation). Call \`movie_help\`
first if the agent needs the command reference or stage contract.

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, gemma-4-12b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated [movie, movie_help] tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  s2-agent cli movie produce a 30s ad: red sports car on a coastal road at golden hour
  s2-agent cli --model sonnet movie "3-scene product demo for a smartwatch"
  s2-agent cli movie -- compose --plan scene_plan.json`,
  factory: extension,
  tools: ["movie", "movie_help"],
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      // No request → let the agent prompt for the production intent.
      return "Use the movie tool to help the user with video production. " +
        "Ask or infer what they want (a concept, duration, scene count, style), " +
        "then drive the orchestration pipeline. Call movie_help first for the " +
        "command reference and stage contract.";
    }
    return "Use the movie tool to fulfill this video-production request. Drive the " +
      "orchestration pipeline (idea → script → scene_plan → assets → edit → compose), " +
      "honoring gate-enforced checkpoints. Call movie_help first if you need the " +
      "command reference. This spends real GPU tokens — run it once and report " +
      "faithfully. Request:\n\n" + request;
  },
};
