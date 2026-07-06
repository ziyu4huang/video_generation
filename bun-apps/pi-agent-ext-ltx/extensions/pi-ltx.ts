/**
 * pi-ltx — wraps the `swift/ltx-video-director` CLI (ltx-video) as ONE agent-
 * optimized tool PLUS a cheap `ltx_help` companion.
 *
 * Design: TWO tools, on the Tool-Search / Lazy-Loading pattern (mirrors
 * pi-agent-ext-flux2/extensions/pi-flux2.ts).
 *
 *   • `ltx` — the dispatcher. The agent picks `command` (one of the ltx-video
 *     subcommands modeled in src/commands.ts — see COMMAND_LIST.length for the
 *     current count; this header deliberately doesn't hardcode a number that
 *     would go stale again) and passes typed `options` (camelCase keys). Its
 *     `description` is intentionally SHORT (~200 tok): only what the model
 *     needs for ROUTING (what ltx is, the subcommand index, the
 *     `details.output` chaining convention). The heavy per-command field
 *     reference is NOT embedded here.
 *
 *   • `ltx_help` — an on-demand reference tool. The model calls it only when it
 *     needs a command's exact option keys / defaults / path rules, or the
 *     native-i2v-vs-i2v docs. Its output is a tool RESULT (lives in conversation
 *     history, not the static schema). It reads the SAME `COMMANDS` spec /
 *     `fieldHints()` as the dispatcher, so it can never drift from what the CLI
 *     actually accepts.
 *
 * The dispatcher still:
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

// ─── On-demand reference builders (shared by the slim description + help tool) ─
//
// SINGLE source of the per-command field reference. The slim `ltx` description
// only embeds the cheap index (commandIndex); the heavy per-command block
// (fieldHints) + the native-i2v-vs-i2v docs live behind `ltx_help`, which calls
// these same functions. Editing a field in src/commands.ts updates BOTH
// surfaces at once — no drift.

/** Per-command field reference (teaches the agent the exact option keys). */
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

/** The cheap one-line-per-subcommand index (kept in the slim description). */
function commandIndex(): string {
  return COMMAND_LIST.map((c) => `  • ${c.name}${c.writesOutput ? " 📤" : ""} — ${c.when}`).join("\n");
}

/** Exact per-command field-reference block (same text the old description embedded). */
function commandFieldBlock(cmdName: CommandName): string {
  return `── ${cmdName} ──\n${fieldHints(cmdName)}`;
}

/** native-i2v vs i2v reference (deferred to ltx_help). */
function nativeVsProdDoc(): string {
  return (
    "── native-i2v vs i2v ──\n" +
    "`native-i2v` is the pure-Swift/MLX experimental path (no run.py anywhere) — distilled transformer " +
    "only, no VLM prompt expansion, PNG frame sequence + WAV (no mp4 muxer yet), but supports FFLF " +
    "(lastFrame) + custom audio injection (audioTrack) + LoRA fusion + an auto post-upscale refine pass. " +
    "`i2v` is the production pipeline (ZImage T2I -> VLM prompt -> LTX I2V) — still bridges through run.py " +
    "for VLM/quality-check/vlm-score, higher default quality/duration, writes a real .mp4."
  );
}

/** One concise worked example per command (illustrative; fieldHints is authoritative). */
const COMMAND_EXAMPLES: Partial<Record<CommandName, string>> = {
  t2i: 'ltx({command:"t2i", options:{prompt:"a serene mountain lake at dawn"}})  → single PNG',
  "native-i2v": 'ltx({command:"native-i2v", options:{prompt:"a cat playing piano", seconds:2, seed:42}})  → frames/ + audio.wav (+ upscaled/); chain details.output into ltx gate',
  "native-upscale": 'ltx({command:"native-upscale", options:{input:"native_i2v_output/frames"}})  → 2x frame sequence',
  "native-t2a": 'ltx({command:"native-t2a", options:{prompt:"gentle rain on a tin roof", seconds:5}})  → audio.wav only',
  "native-relay": 'ltx({command:"native-relay", options:{prompts:["cat walks in","cat jumps out"], firstImage:"start.png", seconds:2}})',
  "native-storyboard": 'ltx({command:"native-storyboard", options:{config:"story.json"}})  → multi-panel video from a JSON config',
  "native-ingredients": 'ltx({command:"native-ingredients", options:{input:"character_ref.png", lora:"ic-lora.safetensors", prompt:"character waving"}})',
  "native-restyle": 'ltx({command:"native-restyle", options:{input:"prev_run/frames", lora:"style.safetensors", prompt:"oil painting style", audio:"prev_run/audio.wav"}})',
  i2v: 'ltx({command:"i2v", options:{prompt:"a woman singing", action:"她開口唱歌", seconds:10}})  → production .mp4 (VLM-expanded motion+voice)',
  upscale: 'ltx({command:"upscale", options:{input:"clip.mp4", scale:2.0}})  → restored upscaled .mp4',
  gate: 'ltx({command:"gate", options:{videos:["clip.mp4"], json:true}})  → quality/audio verdict, no generation',
  verify: 'ltx({command:"verify", options:{video:"clip.mp4", prompt:"a woman singing", keyframes:4}})  → VLM keyframe scoring',
  segment: 'ltx({command:"segment", options:{segmentInput:"long.mp4", threshold:0.4}})  → scene-cut report',
  models: 'ltx({command:"models", options:{}})  → list installed transformer variants (read-only)',
};

function commandExample(cmdName: CommandName): string {
  const ex = COMMAND_EXAMPLES[cmdName];
  if (ex) return `Example:\n  ${ex}`;
  return "Example:\n  (low-level diagnostic — see option list above; pass --latent or --zeros for a smoke test).";
}

/** Slim (~200 tok) description: routing info only. Heavy reference → ltx_help. */
function buildDescription(): string {
  return (
    "Generate/upscale/verify video with LTX-2.3 (pure Swift/MLX on Apple Silicon, standing native-port " +
    "goal — see the repo's project-ltx-swift-native-port memory) via the `ltx-video` CLI. Pass `command` " +
    "(one of the subcommands below) and `options` (camelCase keys; only options relevant to that command " +
    "are read). Every path in `options` must resolve under the repo / output dir / models tree. The " +
    "result's `details.output` is the primary generated path (video/frame-dir/image) — reuse it to chain " +
    "commands (e.g. native-i2v -> gate). `details.extraOutputs` carries secondary paths a command also " +
    "produces (e.g. native-i2v's audio.wav, upscaledFrames).\n\n" +
    "The exact option keys, defaults, and path rules for each command are NOT listed here — call " +
    "`ltx_help({command:\"<name>\"})` to look them up before first use of a command (or anytime you are " +
    "unsure of a key). Unknown/wrong keys are silently ignored. For the native-i2v-vs-i2v tradeoff call " +
    "`ltx_help({topic:\"native-vs-prod\"})`.\n\n" +
    "Subcommands (📤 = produces output):\n" + commandIndex() + "\n\n" +
    "Notes: defaults are the CLI's own (omit a field to use it), EXCEPT `output` — when a command has " +
    "an `output` field and you omit it, this tool injects a timestamped path under the resolved output " +
    "dir so results always land in a stable, externally-discoverable location. Repeatable flags " +
    "(--lora, gate's videos) take arrays."
  );
}

const COMMAND_ENUM = Type.Union(COMMAND_LIST.map((c) => Type.Literal(c.name)), {
  description: "ltx-video subcommand to run.",
});

const HELP_TOPIC_ENUM = Type.Union(
  [Type.Literal("native-vs-prod")],
  { description: "Reference topic to look up instead of a single command." },
);

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
      `Generate/upscale/verify video with LTX-2.3 (Swift/MLX). One tool, ${COMMAND_LIST.length} subcommands; ` +
      "call ltx_help for a command's options; chain via details.output / details.extraOutputs.",
    promptGuidelines: [
      "Before first use of any ltx command (or when unsure of an option key), call ltx_help with that " +
      "command name to get its exact options, defaults, and path rules.",
      "Use ltx for video.",
    ],
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description:
          "Object of camelCase options for the chosen command. Only options valid for `command` are read. " +
          "Get the exact keys/defaults/path rules from ltx_help({command}). Paths must be under an allowed root.",
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

// ─── The on-demand help tool ─────────────────────────────────────────────────
//
// A tool RESULT (lives in conversation history), so the heavy per-command
// reference appears only in the turn it is requested — never in the static
// schema. Reads the SAME COMMANDS spec / fieldHints() as the dispatcher.

function makeLtxHelpTool() {
  return defineTool({
    name: "ltx_help",
    label: "LTX Command Reference",
    description:
      "On-demand reference for the `ltx` tool. Call BEFORE first use of a command (or anytime you are " +
      "unsure of an option key) to get that command's exact option keys, defaults, path rules, and a " +
      "worked example. Omit both args to list all subcommands. Use topic:\"native-vs-prod\" for the " +
      "native-i2v-vs-i2v tradeoff.",
    promptSnippet:
      "Look up ltx command options/defaults/path-rules on demand (call before using a command).",
    parameters: Type.Object({
      command: Type.Optional(COMMAND_ENUM),
      topic: Type.Optional(HELP_TOPIC_ENUM),
    }),

    async execute(_id, params) {
      let text: string;
      if (params.topic) {
        // Only one topic today (native-vs-prod); the union enum guarantees it.
        text = nativeVsProdDoc();
      } else if (params.command) {
        const cmd = params.command as CommandName;
        const spec = COMMANDS[cmd];
        if (!spec) {
          text =
            `Unknown command "${params.command}". Known: ` +
            COMMAND_LIST.map((c) => c.name).join(", ");
        } else {
          text =
            `${commandFieldBlock(cmd)}\n\n` +
            `When: ${spec.when}` +
            (spec.writesOutput ? "  (📤 produces output)" : "  (no output)") +
            `\n\n${commandExample(cmd)}`;
        }
      } else {
        text =
          "ltx-video subcommands (📤 = produces output):\n" + commandIndex() +
          "\n\nPass command:\"<name>\" for that command's exact option keys, defaults, and path rules " +
          "(+ a worked example). Pass topic:\"native-vs-prod\" for the native-i2v-vs-i2v tradeoff. " +
          "Option-list legend: \"[]\" = array; \"path\" = path-validated against repo/output/models roots; " +
          "\"(positional)\" = bare positional arg; \"flag / --no-flag\" = tri-state boolean " +
          "(true emits flag, false emits --no-flag, omit = CLI default).";
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { ok: true, command: params.command ?? null, topic: params.topic ?? null },
      };
    },
  });
}

// ─── Extension factory ───────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeLtxTool());
  pi.registerTool(makeLtxHelpTool());
};

export default extension;
