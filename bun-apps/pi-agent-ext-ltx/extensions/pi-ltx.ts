/**
 * pi-ltx — wraps the `swift/ltx-video-director` CLI (ltx-video) as ONE
 * agent-optimized tool.
 *
 * Design: a single `ltx` dispatcher. The agent picks `command` (one of 10
 * ltx-video subcommands) and passes typed `options` (camelCase keys). The
 * tool:
 *   - resolves / auto-builds the Swift binary,
 *   - validates every image/video/model path against allowed roots (anti-argv-injection),
 *   - streams progress and honors abort,
 *   - parses stdout into structured `details` (output path, dims, wall time,
 *     gate verdict) so the agent can chain steps — e.g. native-i2v -> gate.
 *
 * Load (source mode):
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-ltx/extensions/pi-ltx.ts -p "..."
 * Bundle:
 *   bun scripts/build-bundle.ts  ->  dist/pi-extensions/pi-agent-ext-ltx.bundle.js
 *
 * Env overrides: LTX_VIDEO_BIN, LTX_VIDEO_REPO_ROOT, MLX_OUTPUT_DIR, MLX_MODELS_DIR.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { COMMANDS, COMMAND_LIST, runLtx, PathSafetyError, type CommandName } from "../src/index.ts";

// ─── Per-command field reference (teaches the agent the exact option keys) ───

function fieldHints(cmdName: CommandName): string {
  const spec = COMMANDS[cmdName];
  const entries = Object.entries(spec.fields);
  if (entries.length === 0) return "  (no options)";
  return entries
    .map(([key, f]) => {
      const pathy = f.isPath || f.isPathArray || f.isPathSpecArray ? " path" : "";
      const arr = f.type.endsWith("[]") ? "[]" : "";
      const flagNote = f.positional ? "(positional)" : f.invertedFlag ? `${f.flag} / ${f.invertedFlag}` : f.flag;
      return `    • ${key}${arr}${pathy} [${flagNote}] — ${f.description}`;
    })
    .join("\n");
}

function buildDescription(): string {
  const cmdLines = COMMAND_LIST.map((c) => `  • ${c.name}${c.writesOutput ? " 📤" : ""} — ${c.when}`).join("\n");
  const fieldRef = COMMAND_LIST.map((c) => `── ${c.name} ──\n${fieldHints(c.name as CommandName)}`).join("\n");
  return (
    "Generate/upscale/verify video with LTX-2.3 (pure Swift/MLX on Apple Silicon, standing native-port " +
    "goal — see the repo's project-ltx-swift-native-port memory) via the `ltx-video` CLI. Pass `command` " +
    "(one of the subcommands below) and `options` (camelCase keys; only options relevant to that command " +
    "are read). Every path in `options` must resolve under the repo / output dir / models tree. The " +
    "result's `details.output` is the primary generated path (video/frame-dir/image) — reuse it to " +
    "chain commands (e.g. native-i2v -> gate). `details.extraOutputs` carries secondary paths a command " +
    "also produces (e.g. native-i2v's audio.wav, upscaledFrames).\n\n" +
    "Subcommands (📤 = produces output):\n" + cmdLines + "\n\n" +
    "Per-command `options` reference (camelCase → ltx-video flag(s) shown in brackets; " +
    "'flag / --no-flag' means a tri-state boolean — true emits flag, false emits --no-flag, omit to use the CLI default):\n" +
    fieldRef +
    "\n\nNotes: defaults are the CLI's own (omit a field to use it), EXCEPT `output` — when a command has " +
    "an `output` field and you omit it, this tool injects a timestamped path under the resolved output " +
    "dir (instead of the Swift binary's own relative-to-cwd default) so results always land in a stable, " +
    "externally-discoverable location. Repeatable flags (--lora, gate's videos) take arrays.\n\n" +
    "── native-i2v vs i2v ──\n" +
    "`native-i2v` is the pure-Swift/MLX experimental path (no run.py anywhere) — distilled transformer " +
    "only, no VLM prompt expansion, PNG frame sequence + WAV (no mp4 muxer yet), but supports FFLF " +
    "(lastFrame) + custom audio injection (audioTrack) + LoRA fusion + an auto post-upscale refine pass. " +
    "`i2v` is the production pipeline (ZImage T2I -> VLM prompt -> LTX I2V) — still bridges through run.py " +
    "for VLM/quality-check/vlm-score, higher default quality/duration, writes a real .mp4."
  );
}

const COMMAND_ENUM = Type.Union(COMMAND_LIST.map((c) => Type.Literal(c.name)), {
  description: "ltx-video subcommand to run.",
});

/**
 * Coerce the LLM-supplied `options` into a plain object.
 *
 * `options` is declared `Type.Any()` (its shape is command-dependent), and at
 * least one provider/model pair (zai/glm-5.2) serializes it as a JSON STRING
 * rather than a nested object in the tool-call payload. Downstream code does
 * `key in options`, which throws "options is not an Object" when `options` is a
 * string — killing every invocation, including `{}`. Normalize here at the tool
 * boundary so runLtx always receives a real Record. Mirrors
 * pi-agent-ext-flux2/extensions/pi-flux2.ts's coerceOptions exactly.
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

function makeLtxTool() {
  return defineTool({
    name: "ltx",
    label: "LTX Video Director",
    description: buildDescription(),
    promptSnippet:
      "Generate/upscale/verify video with LTX-2.3 (Swift/MLX). One tool, 10 subcommands; " +
      "chain via details.output / details.extraOutputs.",
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description:
          "Object of camelCase options for the chosen command (see the per-command reference in this " +
          "tool's description). Only options valid for `command` are read. Paths must be under an allowed root.",
      }),
      outputDir: Type.Optional(
        Type.String({
          description: "Output directory override (default: $MLX_OUTPUT_DIR or ../video_generation__output).",
        }),
      ),
      modelsRoot: Type.Optional(
        Type.String({ description: "Models tree root override (default: $MLX_MODELS_DIR or mlx-models)." }),
      ),
      extraArgs: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Escape hatch: raw ltx-video flag tokens (e.g. ["--strict"]). Leading-dash tokens must be ' +
            "allow-listed; value tokens are path-validated.",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      try {
        const { details, summary, stderrTail } = await runLtx({
          command: params.command as CommandName,
          options: coerceOptions(params.options),
          outputDir: params.outputDir,
          modelsRoot: params.modelsRoot,
          extraArgs: params.extraArgs,
          signal,
          onProgress: (u) => onUpdate?.({ kind: "progress", text: u.text }),
        });

        const content = details.ok ? summary : `${summary}\n\n── stderr tail ──\n${stderrTail}`;
        return {
          content: [{ type: "text" as const, text: content }],
          details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isSafety = err instanceof PathSafetyError;
        return {
          content: [
            { type: "text" as const, text: (isSafety ? "ltx-video rejected (path-safety): " : "ltx-video errored: ") + msg },
          ],
          details: { ok: false, error: msg, pathSafety: isSafety },
        };
      }
    },
  });
}

// ─── Extension factory ───────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeLtxTool());
};

export default extension;
