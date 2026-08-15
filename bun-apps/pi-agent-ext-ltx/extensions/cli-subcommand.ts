/**
 * CLI sub-command spec for pi-agent.
 *
 * Lets `pi-agent` expose the ltx extension as a top-level sub-command:
 *
 *   pi-agent cli ltx <natural-language request...>
 *   pi-agent cli --model sonnet ltx generate a 5s video of ocean waves, native-i2v
 *
 * The ltx tool is an agent-driven dispatcher (it picks one of 16 ltx-video
 * sub-commands + typed options), so the CLI passes the user's request as a
 * natural-language task and lets the agent map it onto the `ltx` tool. This
 * mirrors how `krea2` / `flux2` turn positionals into a generation request.
 *
 * This file is dependency-free of pi-agent on purpose: the workspace dep
 * direction is pi-agent → pi-agent-ext-ltx, so the spec is typed with a
 * local structurally-compatible interface (TS structural typing makes it
 * assignable to pi-agent's `ExtensionSubcommandSpec`). See
 * `bun-apps/pi-agent/src/cli/extensions/types.ts` for the canonical shape.
 */
import extension from "./ltx.ts";

/** Local shape of pi-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

export const ltxSubcommand: ExtensionSubcommandSpec = {
  name: "ltx",
  summary: "generate/upscale/verify video with LTX-2.3 (Swift/MLX, zero Python)",
  details: `Usage:
  pi-agent cli ltx <natural-language request...> [options]

The ltx tool is an agent-optimized dispatcher over the \`ltx-video\` Swift/MLX CLI
(16 sub-commands: t2i, native-i2v, native-upscale, native-t2a, native-relay,
native-storyboard, segment, gate, verify, models, …). Give a natural-language
request as positionals; the agent maps it onto the right ltx sub-command + options.

Positionals are the request verbatim. ltx-specific flags (--prompt, --width,
--fps, --seed, …) are NOT parsed by the CLI. Two ways to pass them:
  1. Fold them into the request text: \`ltx 5s video of ocean waves, native-i2v, 24fps\`
     — the agent maps natural language onto ltx options.
  2. Use the \`--\` end-of-options separator to pass raw flags through verbatim:
       pi-agent cli ltx -- native-i2v --prompt "waves" --duration 5
     Everything after \`--\` is appended to the request as-is, so the agent sees
     the exact flags and can forward them via the tool's \`options\`/\`extraArgs\`.

Model/output/models roots can also be set via environment (MLX_OUTPUT_DIR,
MLX_MODELS_DIR, LTX_VIDEO_BIN, …). Use \`--tools\` / \`-V\` / \`--mode json\` for
CLI-level control. Call \`ltx_help\` first if the agent needs exact option keys.

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, gemma-4-12b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated [ltx, ltx_help] tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  pi-agent cli ltx generate a 5s video of ocean waves at sunset, native-i2v
  pi-agent cli --model sonnet ltx upscale the last video to 2x, native-upscale
  pi-agent cli ltx -- native-i2v --image photo.png --prompt "subtle zoom in" --duration 4`,
  factory: extension,
  tools: ["ltx", "ltx_help"],
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      // No request → let the agent prompt for intent rather than no-op.
      return "Use the ltx tool to help the user with video generation. " +
        "Ask or infer what they want (t2i, native-i2v, upscale, relay, …), " +
        "then call ltx with an appropriate command. Call ltx_help first if you " +
        "need the exact option keys for a command.";
    }
    return "Use the ltx tool to fulfill this request. Pick the most appropriate " +
      "ltx sub-command and options; every image/video/model path must resolve under " +
      "the repo / output dir / models tree. Call ltx_help first if you need a " +
      "command's exact option keys or defaults. After generation you may chain " +
      "gate / native-upscale / verify via details.output. Request:\n\n" + request;
  },
};
