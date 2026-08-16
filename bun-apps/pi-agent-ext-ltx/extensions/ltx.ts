/**
 * pi-ltx — wraps the `swift/ltx-video-director` CLI (ltx-video) as ONE agent-
 * optimized tool PLUS a cheap `ltx_help` companion.
 *
 * Design: TWO tools, on the Tool-Search / Lazy-Loading pattern (mirrors
 * pi-agent-ext-flux2/extensions/flux2.ts).
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
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-ltx/extensions/ltx.ts -p "..."
 * Bundle:
 *   bun scripts/build-bundle.ts  ->  dist/pi-extensions/pi-agent-ext-ltx.bundle.js
 *
 * Env overrides: LTX_VIDEO_BIN, LTX_VIDEO_REPO_ROOT, MLX_OUTPUT_DIR, MLX_MODELS_DIR.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import { COMMANDS, COMMAND_LIST, runLtx, PathSafetyError, type CommandName } from "../src/index.ts";
import {
  SHOT_SIZES,
  CAMERA_MOVEMENTS,
  LENS_MM,
  LIGHTING_KEYS,
  DEPTH_OF_FIELDS,
  COLOR_TEMPERATURES,
  type ShotLanguage,
} from "../src/index.ts";

// ─── Gate family (wayfinder ticket 01 — reference form) ─────────────────────
// Declared ONCE by id; ltx + ltx_help both reference it via
// `gating: { gate: "ltx" }` so buildEffectiveGates groups them into one
// co-firing family gate (names[0] === "ltx"). The former per-tool verbatim
// duplication is gone — edit the family here, both tools follow.
GATE_DEFS["ltx"] = {
  id: "ltx",
  keywords: ["ltx", "t2v", "i2v", "vbvr", "video relay", "vbvr relay", "影片特效"],
  requires: {
    nouns: ["video", "影片", "視頻", "視訊", "動畫", "電影"],
    verbs: ["generate", "create", "make", "animate", "produce", "render", "生成", "做", "製作", "剪"],
  },
  description: "LTX text-to-video generation",
};

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
/**
 * Terse routing tags shown in the always-on description + the ltx_help "list
 * all" view. The full `when` sentence + per-field reference stay in ltx_help's
 * per-command path. Falls back to `when` if untagged.
 */
const SUBCOMMAND_TAGS: Record<string, string> = {
  "t2i": "Text → image (native)",
  "native-i2v": "Image → video (flagship, native)",
  "native-upscale": "2× upscale frames (native)",
  "native-t2a": "Text → audio only (native)",
  "native-relay": "Multi-segment prompt-relay video",
  "native-storyboard": "Multi-panel storyboard (JSON config)",
  "native-ingredients": "Video from reference image (IC-LoRA)",
  "native-restyle": "V2V restyle frames (IC-LoRA)",
  "segment": "Detect scene cuts (no generation)",
  "i2v": "Production I2V (bridges run.py)",
  "upscale": "Upscale video (bridges run.py)",
  "gate": "Score video quality (no generation)",
  "verify": "VLM verify quality / prompt adherence",
  "models": "List transformer variants (read-only)",
  "audio-decode": "Decode audio latent → WAV (diagnostic)",
  "video-decode": "Decode video latent → frames (diagnostic)",
};

function commandIndex(): string {
  return COMMAND_LIST.map((c) => `  • ${c.name}${c.writesOutput ? " 📤" : ""} — ${SUBCOMMAND_TAGS[c.name] ?? c.when}`).join("\n");
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
  // Stealth-trimmed: routing one-liner only. Bulk semantics (subcommand list,
  // option keys, defaults, path rules, native-vs-prod tradeoff, shot-language
  // vocab) live in the on-demand `ltx_help` tool result — never the static
  // schema. Trimming saved ~930 tok/req (descLen 3732 → ~205).
  return (
    "Generate/upscale/verify video via ltx-video (LTX-2.3, Swift/MLX). Pass `command` + `options` " +
    "(camelCase). Call `ltx_help({command})` for option keys/defaults/path rules, or `ltx_help` " +
    "with no args to list subcommands."
  );
}

const COMMAND_ENUM = StringEnum(COMMAND_LIST.map((c) => c.name), {
  description: "ltx-video subcommand to run.",
});

const HELP_TOPIC_ENUM = StringEnum(["native-vs-prod", "shot-language"] as const, {
  description: "Reference topic to look up instead of a single command.",
});

/** Optional camera/lighting vocabulary schema — see shotLanguage.ts.
 *  Enum values are intentionally NOT listed inline (saves ~500 tok/req);
 *  the model calls ltx_help({topic:"shot-language"}) for valid values. */
const SHOT_LANGUAGE_SCHEMA = Type.Optional(
  Type.Object(
    {
      shotSize: Type.Optional(Type.String()),
      cameraMovement: Type.Optional(Type.String()),
      lensMm: Type.Optional(Type.Number()),
      lightingKey: Type.Optional(Type.String()),
      depthOfField: Type.Optional(Type.String()),
      colorTemperature: Type.Optional(Type.String()),
    },
    {
      description:
        "Optional camera/lighting vocabulary appended to options.prompt (or every options.prompts " +
        'element for native-relay). Valid values: call ltx_help({topic:"shot-language"}).',
    },
  ),
);

/** Reference doc for the shot-language vocabulary (deferred to ltx_help, same pattern as native-vs-prod). */
function shotLanguageDoc(): string {
  return (
    "── shotLanguage ──\n" +
    "Optional structured camera/lighting fields, rendered to a text clause and appended to " +
    "options.prompt (or every options.prompts element for native-relay). Pure prompt-templating — no " +
    "CLI flag, no model change; LTX-2.3 has no named-camera-move control, this just phrases the request " +
    "consistently. Concept adapted from ../OpenMontage's scene_plan.shot_language vocabulary.\n\n" +
    `  shotSize: ${SHOT_SIZES.join(" | ")}\n` +
    `  cameraMovement: ${CAMERA_MOVEMENTS.join(" | ")}\n` +
    `  lensMm: ${LENS_MM.join(" | ")}\n` +
    `  lightingKey: ${LIGHTING_KEYS.join(" | ")}\n` +
    `  depthOfField: ${DEPTH_OF_FIELDS.join(" | ")}\n` +
    `  colorTemperature: ${COLOR_TEMPERATURES.join(" | ")}\n\n` +
    'Example:\n  ltx({command:"native-i2v", options:{prompt:"a cat playing piano"}, ' +
    'shotLanguage:{shotSize:"close_up", cameraMovement:"dolly_in", lensMm:35, lightingKey:"golden_hour"}})'
  );
}

/**
 * Coerce the LLM-supplied `options` into a plain object.
 *
 * `options` is declared `Type.Any()` (its shape is command-dependent), and at
 * least one provider/model pair (zai/glm-5.2) serializes it as a JSON STRING
 * rather than a nested object in the tool-call payload. Downstream code does
 * `key in options`, which throws "options is not an Object" when `options` is a
 * string — killing every invocation, including `{}`. Normalize here at the tool
 * boundary so runLtx always receives a real Record. Mirrors
 * pi-agent-ext-flux2/extensions/flux2.ts's coerceOptions exactly.
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
    // Owner-declared gating — reference form (wayfinder ticket 01): family
    // declared once in GATE_DEFS["ltx"] above; ltx + ltx_help reference it so
    // buildEffectiveGates groups them into one co-firing gate (names[0] ===
    // "ltx") — preserving the original co-fire behavior.
    gating: { gate: "ltx" },
    // promptSnippet + promptGuidelines REMOVED (stealth): usage is taught via
    // the routing description + the on-demand ltx_help tool, not per-turn
    // system-prompt injection. Saves ~120 tok/req.
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
      shotLanguage: SHOT_LANGUAGE_SCHEMA,
    }),

    async execute(_id, params, signal, onUpdate, _ctx) {
      try {
        const { details, summary, stderrTail } = await runLtx({
          command: params.command as CommandName,
          options: coerceOptions(params.options),
          outputDir: params.outputDir,
          modelsRoot: params.modelsRoot,
          extraArgs: params.extraArgs,
          shotLanguage: params.shotLanguage as ShotLanguage | undefined,
          signal,
          onProgress: (u) => onUpdate?.({ content: [{ type: "text" as const, text: u.text }], details: {} }),
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
    // Owner-declared gating — reference form: same GATE_DEFS["ltx"] family as
    // the ltx dispatcher, so the two co-fire together (ticket 01).
    gating: { gate: "ltx" },
    description:
      "On-demand reference for the `ltx` tool. Pass {command} for that command's option keys/defaults/path rules + example; omit args to list subcommands; {topic} for native-vs-prod / shot-language.",
    parameters: Type.Object({
      // COMMAND_ENUM is intentionally NOT used here — the main `ltx` tool
      // already carries the full command enum in its schema (always co-active
      // with ltx_help), so duplicating it here was pure schema tax. A free
      // string + the no-args listing covers discovery; invalid names return the
      // known list (wayfinder ticket 05 — ~−190 tok/req).
      command: Type.Optional(
        Type.String({
          description:
            "ltx subcommand to look up (valid values: the ltx tool's `command` enum). " +
            "Omit to list all subcommands; an unknown name returns the known list.",
        }),
      ),
      topic: Type.Optional(HELP_TOPIC_ENUM),
    }),

    async execute(_id, params) {
      let text: string;
      if (params.topic) {
        text = params.topic === "shot-language" ? shotLanguageDoc() : nativeVsProdDoc();
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

  // Promote to default-load (always active) so the agent sees ltx/ltx_help
  // on every turn without tool-search.
  pi.on('session_start', () => {
    const current = pi.getActiveTools();
    if (!current.includes('ltx')) {
      pi.setActiveTools([...new Set([...current, 'ltx', 'ltx_help'])]);
    }
  });
};

/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime `gating`
 * object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Plain object:
 * no `satisfies` / type import, so the extension never depends on tool-gate
 * (avoids a circular dep); shape is enforced by tool-gate's drift-guard test.
 *  - controls[]  carry a current keyword / satisfy requires → MUST fire.
 *  - adversarial[] are keyword-free "I need this tool" phrasings → should fire
 *    via the noun∧verb `requires` co-occurrence path.
 */
export const __GATE_PROBES__ = {
	gate: "ltx",
	recallFloor: 0.9,
	adversarial: ["animate the sequence into a video", "produce a video clip of that transition", "把這段做成影片"],
	controls: ["generate a video", "t2v the prompt", "用 ltx 生成影片"],
};

export default extension;
