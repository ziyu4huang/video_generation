/**
 * CLI sub-command spec for s2-agent.
 *
 * Lets `s2-agent` expose the flux2 extension as a top-level sub-command:
 *
 *   s2-agent cli flux2 <natural-language request...>
 *   s2-agent cli --model sonnet flux2 generate a red cube on a table, t2i
 *
 * The flux2 tool is an agent-driven dispatcher (it picks one of 18 flux2
 * sub-commands + typed options), so the CLI passes the user's request as a
 * natural-language task and lets the agent map it onto the `flux2` tool. This
 * mirrors how `zk-ask` turns positionals into a question.
 *
 * This file is dependency-free of s2-agent on purpose: the workspace dep
 * direction is s2-agent → s2-agent-ext-flux2, so the spec is typed with a
 * local structurally-compatible interface (TS structural typing makes it
 * assignable to s2-agent's `ExtensionSubcommandSpec`). See
 * `bun-apps/s2-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension from "./flux2.ts";

/** Local shape of s2-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

export const flux2Subcommand: ExtensionSubcommandSpec = {
  name: "flux2",
  summary: "generate/edit/gate images with Flux2 Klein (Swift/MLX)",
  details: `Usage:
  s2-agent cli flux2 <natural-language request...> [options]

The flux2 tool is an agent-optimized dispatcher over the \`flux2\` Swift/MLX CLI
(18 sub-commands: t2i, scene, gate, upscale, …). Give a natural-language request
as positionals; the agent maps it onto the right flux2 sub-command + options.

Positionals are the request verbatim. flux2-specific flags (--prompt, --width, …)
are NOT parsed by the CLI. Two ways to pass them:
  1. Fold them into the request text: \`flux2 generate a red cube, t2i, width 1024\`
     — the agent maps natural language onto flux2 options.
  2. Use the \`--\` end-of-options separator to pass raw flags through verbatim:
       s2-agent cli flux2 -- t2i --prompt "a red cube" --width 1024
     Everything after \`--\` is appended to the request as-is, so the agent sees
     the exact flags and can forward them via the tool's \`options\`/\`extraArgs\`.

Model/output/models roots can also be set via environment (MLX_OUTPUT_DIR,
MLX_MODELS_DIR, FLUX2_BIN, …). Use \`--tools\` / \`-V\` / \`--mode json\` for
CLI-level control.

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, bonsai-27b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated [flux2] tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  s2-agent cli flux2 generate a red cube on a table using t2i
  s2-agent cli --model sonnet flux2 scene: two people talking, left/right
  s2-agent cli flux2 t2i then gate then upscale the result`,
  factory: extension,
  tools: ["flux2"],
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      // No request → let the agent prompt for intent rather than no-op.
      return "Use the flux2 tool to help the user with image generation. " +
        "Ask or infer what they want, then call flux2 with an appropriate command.";
    }
    return "Use the flux2 tool to fulfill this request. Pick the most appropriate " +
      "flux2 sub-command and options; every image/model path must resolve under the " +
      "repo / output dir / models tree. After generation, the tool auto-runs `gate`; " +
      "chain `upscale` if useful. Request:\n\n" + request;
  },
};

/**
 * `flux2-self-improve` sub-command: the CLOSED self-improve loop
 * (generate → judge → reflect → retry), reached as ONE top-level command so the
 * user does not need to know the workflow-tool incantation. It shells out to
 * run-self-improve-loop.sh (which drives the loop workflow via the s2-agent
 * workflow tool) — robust whether or not the workflow tool is registered in the
 * current mode, because bash is always available to the agent.
 *
 *   s2-agent cli flux2-self-improve a dancer's pose, 3 attempts
 *   s2-agent cli flux2-self-improve --pose-id L3-01 --attempts 5
 */
export const selfImproveSubcommand: ExtensionSubcommandSpec = {
  name: "flux2-self-improve",
  summary: "closed self-improve loop for Flux2 (generate→judge→reflect→retry via pose_dsg)",
  details: `Usage:
  s2-agent cli flux2-self-improve <request...> [options]

Runs the closed, bounded self-improve loop for flux2: generate → judge (pose_dsg
for complex poses, holistic score otherwise) → on below-threshold, reflect
(failed atoms → targeted prompt expansion) → retry, seed-locked per attempt,
best-so-far ranked comparatively by the per-atom matrix. Appends the winning
(prompt → params → verdict) exemplar for future runs. PROPOSE-ONLY: never
auto-applies edits.

This command shells out to the runner, which drives the loop workflow via the
s2-agent workflow tool. It spends real GPU + VLM tokens (opt-in, NOT in CI).

The request is forwarded to the runner. To pick a pose from the library
(bun-apps/s2-agent-ext-flux2/workflows/poses.json), name it in the request
(e.g. "dancer's pose L3-01") or pass flux2-self-improve-specific flags after the
request verbatim; the agent maps them onto the runner's --pose-id / --prompt /
--attempts / --seed / --steps flags.

Examples:
  s2-agent cli flux2-self-improve a dancer's pose (nataraja), 3 attempts
  s2-agent cli flux2-self-improve --pose-id L3-01 --attempts 5 --seed 42
  s2-agent cli flux2-self-improve a red apple on a table (non-pose loop)`,
  factory: extension,
  tools: ["flux2"],
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    const base =
      "Run the flux2 self-improve loop by shelling out to the runner script " +
      "(do NOT call the flux2 tool yourself — the runner drives the full loop):\n" +
      "  bash bun-apps/s2-agent/scripts/run-self-improve-loop.sh\n" +
      "Map the user's request onto the runner's flags: a named pose (e.g. " +
      "'dancer\\'s pose', 'L3-01') → --pose-id <id> or the matching poses.json " +
      "entry; otherwise pass the bare description as --prompt. Attempts/seed/steps " +
      "if mentioned → --attempts/--seed/--steps. Report the structured result the " +
      "runner prints (converged, attemptsUsed, winnerPath, needsReview). " +
      "It spends real GPU+VLM tokens — run it once and report faithfully.\n";
    return request ? base + "Request:\n\n" + request : base;
  },
};
