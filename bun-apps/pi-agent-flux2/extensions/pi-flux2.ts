/**
 * pi-flux2 — wraps the `swift/flux2-image-director` CLI (flux2) as ONE agent-
 * optimized tool.
 *
 * Design: a single `flux2` dispatcher. The agent picks `command` (one of 18
 * flux2 subcommands) and passes typed `options` (camelCase keys). The tool:
 *   • resolves / auto-builds the Swift binary,
 *   • validates every image/model path against allowed roots (anti-argv-injection),
 *   • streams progress and honors abort,
 *   • parses the .manifest.json sidecar into structured `details` (output path,
 *     dimensions, seed, gate verdict, perf) so the agent can chain steps, and
 *     auto-runs `flux2 gate` on every generation to surface a quality verdict.
 *
 * Load (source mode):
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-flux2/extensions/pi-flux2.ts -p "..."
 * Bundle:
 *   bun scripts/build-bundle.ts  →  dist/pi-extensions/pi-agent-flux2.bundle.js
 *
 * Env overrides: FLUX2_BIN, FLUX2_REPO_ROOT, MLX_OUTPUT_DIR, MLX_MODELS_DIR.
 */
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  COMMANDS,
  COMMAND_LIST,
  runFlux2,
  PathSafetyError,
  type CommandName,
} from "../src/index.ts";

// ─── Per-command field reference (teaches the agent the exact option keys) ───

function fieldHints(cmdName: CommandName): string {
  const spec = COMMANDS[cmdName];
  const entries = Object.entries(spec.fields);
  if (entries.length === 0) return "  (no options)";
  return entries
    .map(([key, f]) => {
      const pathy = f.isPath || f.isPathArray ? " path" : "";
      const arr = f.type.endsWith("[]") ? "[]" : "";
      const flagNote = f.positional ? "(positional)" : f.flag;
      return `    • ${key}${arr}${pathy} [${flagNote}] — ${f.description}`;
    })
    .join("\n");
}

function buildDescription(): string {
  const cmdLines = COMMAND_LIST.map(
    (c) => `  • ${c.name}${c.writesImage ? " 📤" : ""} — ${c.when}`,
  ).join("\n");
  const fieldRef = COMMAND_LIST.map(
    (c) => `── ${c.name} ──\n${fieldHints(c.name as CommandName)}`,
  ).join("\n");
  return (
    "Generate or edit images with the Flux2 Klein model (pure Swift/MLX on Apple Silicon) " +
    "via the `flux2` CLI. Pass `command` (one of the subcommands below) and `options` " +
    "(camelCase keys; only the options relevant to that command are read). Every path in " +
    "`options` must resolve under the repo / output dir / models tree. The result's " +
    "`details.output` is the generated PNG path — reuse it to chain commands " +
    "(e.g. scene → gate → upscale). Set options.strictGate true to abort on a FAIL gate.\n\n" +
    "Subcommands (📤 = produces an image):\n" + cmdLines + "\n\n" +
    "Per-command `options` reference (camelCase → flux2 flag shown in brackets):\n" + fieldRef +
    "\n\nNotes: defaults are the CLI's own (omit a field to use it). Repeatable flags " +
    "(--ref, --lora, --ref-strength, --lora-scale, --ref-mask, --ref-region-mask) take arrays.\n\n" +
    "── Multi-seed scene pipeline (command: 'scene' + scenePipeline) ──\n" +
    "`scene` refs are GLOBAL tokens (no identity→region binding), so placement/pose is " +
    "prompt-driven & reliable-but-probabilistic. Set `scenePipeline` to render the SAME scene " +
    "options across multiple seeds, gate each, optionally VLM-verify each against a question, " +
    "and auto-pick a winner — instead of you looping single `scene` calls yourself:\n" +
    "  • seeds (number[], required) — one render per seed, in order.\n" +
    "  • verifyPrompt (string, optional) — question asked of a VLM subagent about each " +
    "rendered candidate (e.g. \"Describe each person's LEFT/RIGHT position and pose.\").\n" +
    "  • verifyMatch (string[], optional) — case-insensitive substrings that must ALL appear " +
    "in a candidate's VLM reply for it to be the winner; first matching seed (in order) wins. " +
    "Falls back to the best-gated candidate if omitted or nothing matches.\n" +
    "  • vlmModel (string, optional) — \"provider/modelId\" override for the VLM subagent " +
    "(default: lm-studio/google/gemma-4-26b-a4b-qat).\n" +
    "  • handRepairWinner (boolean, optional) — re-render the winning seed once more with " +
    "--hand-repair.\n" +
    "Result: `details.output` is the winner's (or hand-repaired winner's) PNG path — chains " +
    "exactly like a single scene call. `details.scenePipeline.candidates[]` has every seed's " +
    "output/gate/VLM verdict for inspection."
  );
}

const COMMAND_ENUM = Type.Union(
  COMMAND_LIST.map((c) => Type.Literal(c.name)),
  { description: "flux2 subcommand to run." },
);

/**
 * Coerce the LLM-supplied `options` into a plain object.
 *
 * `options` is declared `Type.Any()` (its shape is command-dependent), and at
 * least one provider/model pair (zai/glm-5.2) serializes it as a JSON STRING
 * rather than a nested object in the tool-call payload. Downstream code does
 * `key in options`, which throws "options is not an Object" when `options` is a
 * string — killing every invocation, including `{}`. Normalize here at the tool
 * boundary so runFlux2 always receives a real Record.
 */
export function coerceOptions(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return {};
    try {
      const p = JSON.parse(s);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ─── The dispatcher tool ─────────────────────────────────────────────────────

function makeFlux2Tool() {
  return defineTool({
    name: "flux2",
    label: "Flux2 Image Director",
    description: buildDescription(),
    promptSnippet:
      "Generate/edit/gate images with Flux2 (Swift/MLX). One tool, 18 subcommands; " +
      "chain via details.output.",
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description:
          "Object of camelCase options for the chosen command (see the per-command reference " +
          "in this tool's description). Only options valid for `command` are read. Paths must " +
          "be under an allowed root.",
      }),
      outputDir: Type.Optional(
        Type.String({
          description:
            "Output directory override (default: $MLX_OUTPUT_DIR or ../video_generation__output).",
        }),
      ),
      modelsRoot: Type.Optional(
        Type.String({
          description:
            "Models tree root override (default: $MLX_MODELS_DIR or mlx-models).",
        }),
      ),
      extraArgs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Escape hatch: raw flux2 flag tokens (e.g. [\"--strict-gate\"]). Leading-dash tokens " +
            "must be allow-listed; value tokens are path-validated.",
        }),
      ),
      scenePipeline: Type.Optional(
        Type.Object(
          {
            seeds: Type.Array(Type.Integer(), {
              description: "Render this scene once per seed, in order. Required to trigger the pipeline.",
            }),
            verifyPrompt: Type.Optional(
              Type.String({ description: "Question asked of a VLM subagent about each rendered candidate." }),
            ),
            verifyMatch: Type.Optional(
              Type.Array(Type.String(), {
                description:
                  "Case-insensitive substrings that must ALL appear in a candidate's VLM reply to win " +
                  "(first matching seed, in order). Falls back to the best-gated candidate otherwise.",
              }),
            ),
            vlmModel: Type.Optional(
              Type.String({
                description: "\"provider/modelId\" override for the VLM subagent (default lm-studio/google/gemma-4-26b-a4b-qat).",
              }),
            ),
            handRepairWinner: Type.Optional(
              Type.Boolean({ description: "Re-render the winning seed once more with --hand-repair." }),
            ),
          },
          {
            description:
              "Only meaningful when command is 'scene'. Renders `options` across multiple seeds, gates + " +
              "optionally VLM-verifies each, and returns the winner as details.output. See the tool " +
              "description's 'Multi-seed scene pipeline' section.",
          },
        ),
      ),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      try {
        const { details, summary, stderrTail } = await runFlux2({
          command: params.command as CommandName,
          options: coerceOptions(params.options),
          outputDir: params.outputDir,
          modelsRoot: params.modelsRoot,
          extraArgs: params.extraArgs,
          scenePipeline: params.scenePipeline as any,
          signal,
          onProgress: (u) => onUpdate?.({ kind: "progress", text: u.text }),
        });

        const content = details.ok
          ? summary
          : `${summary}\n\n── stderr tail ──\n${stderrTail}`;
        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isSafety = err instanceof PathSafetyError;
        return {
          content: [
            {
              type: "text" as const,
              text: (isSafety ? "flux2 rejected (path-safety): " : "flux2 errored: ") + msg,
            },
          ],
          details: { ok: false, error: msg, pathSafety: isSafety },
        };
      }
    },
  });
}

// ─── Extension factory ───────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeFlux2Tool());
};

export default extension;
