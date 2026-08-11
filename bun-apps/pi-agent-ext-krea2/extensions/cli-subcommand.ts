/**
 * CLI sub-command spec for pi-agent.
 *
 * Lets `pi-agent` expose the krea2 extension as a top-level sub-command:
 *
 *   pi-agent cli krea2 <natural-language request...>
 *   pi-agent cli --model sonnet krea2 generate a red cube on a table, t2i
 *
 * The krea2 tool is an agent-driven dispatcher (it picks t2i vs i2i + typed
 * options), so the CLI passes the user's request as a natural-language task
 * and lets the agent map it onto the `krea2` tool.
 *
 * This file is dependency-free of pi-agent on purpose: the workspace dep
 * direction is pi-agent → pi-agent-ext-krea2, so the spec is typed with a
 * local structurally-compatible interface (TS structural typing makes it
 * assignable to pi-agent's `ExtensionSubcommandSpec`).
 */
import extension from "./krea2.ts";

/** Local shape of pi-agent's ExtensionSubcommandSpec (structural match). */
interface ExtensionSubcommandSpec {
  name: string;
  summary: string;
  details: string;
  factory: unknown;
  tools: string[];
  task: (parsed: { positionals: string[] }) => string;
}

export const krea2Subcommand: ExtensionSubcommandSpec = {
  name: "krea2",
  summary: "generate/edit images with Krea 2 Turbo (Swift/MLX, zero Python)",
  details: `Usage:
  pi-agent cli krea2 <natural-language request...> [options]

The krea2 tool is an agent-optimized dispatcher over the \`krea2\` Swift/MLX CLI
(2 sub-commands: t2i, i2i). Give a natural-language request as positionals; the
agent maps it onto the right krea2 sub-command + options.

Positionals are the request verbatim. krea2-specific flags (--prompt, --width, …)
are NOT parsed by the CLI. Two ways to pass them:
  1. Fold them into the request text: \`krea2 generate a red cube, t2i, width 1024\`
     — the agent maps natural language onto krea2 options.
  2. Use the \`--\` end-of-options separator to pass raw flags through verbatim:
       pi-agent cli krea2 -- t2i --prompt "a red cube" --width 1024
     Everything after \`--\` is appended to the request as-is.

Model/output/models roots can also be set via environment (MLX_OUTPUT_DIR,
MLX_MODELS_DIR, KREA2_BIN, …). Use \`--tools\` / \`-V\` / \`--mode json\` for
CLI-level control.

Options (pi-aligned globals):
  --model <pattern>      provider/id[:thinking]  (e.g. sonnet, gemma-4-26b)
  --provider <name>      provider name
  --thinking <level>     off|minimal|low|medium|high|xhigh
  --tools <csv>          override the curated [krea2] tool allowlist
  --mode json            NDJSON event stream (for programmatic consumers)
  -V, --verbose          tool verbosity (repeat for debug)

Examples:
  pi-agent cli krea2 generate a red apple on a wooden table using t2i
  pi-agent cli krea2 edit <png> into a green apple on marble, strength 0.9
  pi-agent cli krea2 -- t2i --prompt "a red cube" --width 1024`,
  factory: extension,
  tools: ["krea2"],
  task: (parsed) => {
    const request = parsed.positionals.join(" ").trim();
    if (!request) {
      return "Use the krea2 tool to help the user with image generation. " +
        "Ask or infer what they want (t2i or i2i), then call krea2 with the appropriate command.";
    }
    return "Use the krea2 tool to fulfill this request. Pick t2i (text→image) or i2i " +
      "(image→image edit) and the appropriate options; every image path must resolve under the " +
      "repo / output dir / models tree. Reuse details.output to chain. Request:\n\n" + request;
  },
};
