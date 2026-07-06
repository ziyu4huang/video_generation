/**
 * pi-krea2 — wraps the `swift/krea2-image-director` CLI (krea2) as ONE agent-
 * optimized tool.
 *
 * Design: a single `krea2` dispatcher. The agent picks `command` (t2i | i2i)
 * and passes typed `options` (camelCase keys). The tool:
 *   • resolves / auto-builds the Swift binary (+ stages mlx.metallib),
 *   • validates every image path against allowed roots (anti-argv-injection),
 *   • streams progress and honors abort,
 *   • parses the `[krea2] saved <path>` line into structured `details` so the
 *     agent can chain t2i → i2i via `details.output`.
 *
 * Load (source mode):
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-krea2/extensions/pi-krea2.ts -p "..."
 * Bundle:
 *   bun scripts/build-bundle.ts  →  dist/pi-extensions/pi-agent-ext-krea2.bundle.js
 *
 * Env overrides: KREA2_BIN, KREA2_REPO_ROOT, MLX_OUTPUT_DIR, MLX_MODELS_DIR.
 */
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  COMMANDS,
  COMMAND_LIST,
  runKrea2,
  PathSafetyError,
  type CommandName,
  type Krea2Details,
} from "../src/index.ts";

// ─── Per-command field reference (teaches the agent the exact option keys) ───

function fieldHints(cmdName: CommandName): string {
  const spec = COMMANDS[cmdName];
  if (!spec) return "  (no options)";
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
    (c) => `  • ${c.name} 📤 — ${c.when}`,
  ).join("\n");
  const fieldRef = COMMAND_LIST.map(
    (c) => `── ${c.name} ──\n${fieldHints(c.name as CommandName)}`,
  ).join("\n");
  return (
    "Generate or edit images with Krea 2 Turbo (pure Swift/MLX on Apple Silicon, zero Python) " +
    "via the `krea2` CLI. Pass `command` (t2i | i2i) and `options` (camelCase keys; only the " +
    "options relevant to that command are read). Every path in `options` (--out, --input) must " +
    "resolve under the repo / output dir / models tree. The result's `details.output` is the " +
    "generated PNG path — reuse it to chain commands (e.g. t2i → i2i).\n\n" +
    "Subcommands (📤 = produces an image):\n" + cmdLines + "\n\n" +
    "Per-command `options` reference (camelCase → krea2 flag shown in brackets):\n" + fieldRef +
    "\n\nNotes: defaults are the CLI's own (omit a field to use it). Krea 2 Turbo uses 8 steps " +
    "and mu=1.15; width/height must be multiples of 16. For i2i, `strength` is the source-fidelity " +
    "lever — low (≈0.6) preserves the input, high (≈0.9) follows the prompt."
  );
}

const COMMAND_ENUM = Type.Union(
  COMMAND_LIST.map((c) => Type.Literal(c.name)),
  { description: "krea2 subcommand to run." },
);

/**
 * Coerce the LLM-supplied `options` into a plain object.
 *
 * `options` is declared `Type.Any()` (its shape is command-dependent), and at
 * least one provider/model pair (zai/glm-5.2) serializes it as a JSON STRING
 * rather than a nested object in the tool-call payload. Downstream code does
 * `key in options`, which throws when `options` is a string — killing every
 * invocation. Normalize here at the tool boundary. See memory
 * [[pi-tool-any-param-stringified-by-provider]].
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

function makeKrea2Tool() {
  return defineTool({
    name: "krea2",
    label: "Krea 2 Image Director",
    description: buildDescription(),
    promptSnippet:
      "Generate/edit images with Krea 2 Turbo (Swift/MLX). One tool, 2 subcommands (t2i, i2i); " +
      "chain via details.output.",
    promptGuidelines: [
      "Use krea2 for a fast single-image draft or light i2i edit (8 steps). Escalate to flux2 for " +
      "multi-character scene composition, style transfer, or higher-fidelity generation; use ltx for video.",
    ],
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
            "Output directory override (default: $MLX_OUTPUT_DIR or ../video_generation__output). NOT a krea2 flag — used for path validation + dir ensure.",
        }),
      ),
      modelsRoot: Type.Optional(
        Type.String({
          description:
            "Models tree root override (default: $MLX_MODELS_DIR or mlx-models). NOT a krea2 flag — used for path validation only.",
        }),
      ),
      extraArgs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Escape hatch: raw krea2 flag tokens (e.g. [\"--bridge\"]). Leading-dash tokens " +
            "must be allow-listed; value tokens are path-validated.",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      try {
        const { details, summary, stderrTail } = await runKrea2({
          command: params.command as CommandName,
          options: coerceOptions(params.options),
          outputDir: params.outputDir,
          modelsRoot: params.modelsRoot,
          extraArgs: params.extraArgs,
          signal,
          onProgress: (u) =>
            onUpdate?.({
              content: [{ type: "text", text: u.text }],
              // A progress update is a PARTIAL result streamed mid-execution;
              // the full Krea2Details aren't known until the process exits.
              // Cast satisfies the SDK shape without lying about details that
              // don't exist yet (mirrors flux2's treatment).
              details: undefined as unknown as Krea2Details,
            }),
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
              text: (isSafety ? "krea2 rejected (path-safety): " : "krea2 errored: ") + msg,
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
  pi.registerTool(makeKrea2Tool());
};

export default extension;
