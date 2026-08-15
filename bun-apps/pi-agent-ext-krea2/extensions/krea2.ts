/**
 * pi-krea2 — wraps the `swift/krea2-image-director` CLI (krea2) as ONE agent-
 * optimized tool PLUS a cheap `krea2_help` companion.
 *
 * Design: TWO tools, on the Tool-Search / Lazy-Loading pattern (mirrors
 * flux2.ts).
 *
 *   • `krea2` — the dispatcher. The agent picks `command` (t2i | i2i) and
 *     passes typed `options` (camelCase keys). Its `description` is
 *     intentionally SHORT (~120 tok): only what the model needs for ROUTING
 *     (what krea2 is, the 2-subcommand index, the `details.output` chaining
 *     convention, and the tiny failure-preventing notes: 8 steps / mu=1.15 /
 *     multiples of 16 / `strength` lever). The per-command field reference is
 *     NOT embedded here — it lives behind `krea2_help`.
 *
 *   • `krea2_help` — an on-demand reference tool (~80 tok schema). The model
 *     calls it only when it needs a command's exact option keys / defaults /
 *     path rules. Its output is a tool RESULT (lives in conversation history,
 *     not the static schema), so the heavy text appears only in the turn where
 *     it is requested. It reads the SAME `COMMANDS` spec / `fieldHints()` as
 *     the dispatcher, so it can never drift from what the CLI actually accepts.
 *
 * The dispatcher still:
 *   • resolves / auto-builds the Swift binary (+ stages mlx.metallib),
 *   • validates every image path against allowed roots (anti-argv-injection),
 *   • streams progress and honors abort,
 *   • parses the `[krea2] saved <path>` line into structured `details` so the
 *     agent can chain t2i → i2i via `details.output`.
 *
 * Load (source mode):
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-krea2/extensions/krea2.ts -p "..."
 * Bundle:
 *   bun scripts/build-bundle.ts  →  dist/pi-extensions/pi-agent-ext-krea2.bundle.js
 *
 * Env overrides: KREA2_BIN, KREA2_REPO_ROOT, MLX_OUTPUT_DIR, MLX_MODELS_DIR.
 */
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  COMMANDS,
  COMMAND_LIST,
  runKrea2,
  PathSafetyError,
  type CommandName,
  type Krea2Details,
} from "../src/index.ts";

// ─── On-demand reference builders (shared by the slim description + help tool) ─
//
// These are the SINGLE source of the per-command field reference. The slim
// `krea2` description only embeds the cheap index (commandIndex); the heavy
// per-command block (fieldHints) lives behind `krea2_help`, which calls these
// same functions. Editing a field in src/commands.ts therefore updates BOTH
// surfaces at once — no drift.

/** Per-command field reference (teaches the agent the exact option keys). */
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

/** The cheap one-line-per-subcommand index (kept in the slim description). */
function commandIndex(): string {
  return COMMAND_LIST.map(
    (c) => `  • ${c.name}${c.writesImage ? " 📤" : ""} — ${c.when}`,
  ).join("\n");
}

/** Exact per-command field-reference block (same text the old description embedded). */
function commandFieldBlock(cmdName: CommandName): string {
  return `── ${cmdName} ──\n${fieldHints(cmdName)}`;
}

/** One concise worked example per command (illustrative; fieldHints is authoritative). */
const COMMAND_EXAMPLES: Partial<Record<CommandName, string>> = {
  t2i: 'krea2({command:"t2i", options:{prompt:"a red panda eating bamboo, studio light", seed:42, width:1024, height:1024}})',
  i2i: 'krea2({command:"i2i", options:{input:"out.png", prompt:"make it look like an oil painting", strength:0.7}})  → reuse details.output to chain',
};

function commandExample(cmdName: CommandName): string {
  const ex = COMMAND_EXAMPLES[cmdName];
  if (ex) return `Example:\n  ${ex}`;
  return "Example:\n  (see the option list above).";
}

/** Slim (~120 tok) description: routing info + failure-preventing notes only. Heavy reference → krea2_help. */
function buildDescription(): string {
  return (
    "Generate or edit images with Krea 2 Turbo (pure Swift/MLX on Apple Silicon, zero Python) " +
    "via the `krea2` CLI. Pass `command` (t2i | i2i) and `options` (camelCase keys; only the " +
    "options relevant to that command are read). Every path in `options` (--out, --input) must " +
    "resolve under the repo / output dir / models tree. The result's `details.output` is the " +
    "generated PNG path — reuse it to chain commands (e.g. t2i → i2i).\n\n" +
    "The exact option keys, defaults, and path rules for each command are NOT listed here — " +
    "call `krea2_help({command:\"<name>\"})` to look them up before first use of a command " +
    "(or anytime you are unsure of a key). Unknown/wrong keys are silently ignored and waste a " +
    "generation.\n\n" +
    "Subcommands (📤 = produces an image):\n" + commandIndex() + "\n\n" +
    "Notes: defaults are the CLI's own (omit a field to use it). Krea 2 Turbo uses 8 steps " +
    "and mu=1.15; width/height must be multiples of 16. For i2i, `strength` is the source-fidelity " +
    "lever — low (≈0.6) preserves the input, high (≈0.9) follows the prompt."
  );
}

const COMMAND_ENUM = StringEnum(COMMAND_LIST.map((c) => c.name), {
  description: "krea2 subcommand to run.",
});

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
    // Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
    // {names:["krea2","krea2_help"]} gate). Per ticket 06's semantics-preserving
    // rule, the SAME gating is mirrored on krea2_help so both activate together
    // and reconstructOwnerDeclaredGates collapses them back into one multi-name
    // gate (names[0] === "krea2"). Keywords cover the narrow krea/草圖/快速生成/
    // sketch/real-time triggers; the noun∧verb `requires` path mirrors flux2 so
    // keyword-free paraphrases (doodle a concept / live-draw a mockup / 畫草稿)
    // also reach the gate (gate-recall adversarial floor 0.9).
    gating: {
      keywords: ["krea", "krea2", "草圖", "快速生成", "即時生成", "實時繪圖", "sketch", "real-time", "real time"],
      requires: {
        nouns: ["doodle", "concept", "mockup", "draft", "草稿", "概念"],
        verbs: ["draw", "doodle", "live-draw", "render", "畫", "塗鴉", "速寫"],
      },
    },
    promptSnippet:
      "Generate/edit images with Krea 2 Turbo (Swift/MLX). One tool, 2 subcommands (t2i, i2i); " +
      "call krea2_help for a command's options; chain via details.output.",
    promptGuidelines: [
      "Use krea2 for a fast single-image draft or light i2i (8 steps); escalate to flux2 for " +
      "multi-character scenes, style transfer, or higher fidelity. Call krea2_help({command}) " +
      "before first use of a command or when unsure of an option key.",
    ],
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description:
          "Object of camelCase options for the chosen command. Only options valid for `command` " +
          "are read. Get the exact keys/defaults/path rules from krea2_help({command}). Paths must " +
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

// ─── The on-demand help tool (~80 tok schema) ────────────────────────────────
//
// A tool RESULT (lives in conversation history), so the per-command reference
// appears only in the turn it is requested — never in the static schema. Reads
// the SAME COMMANDS spec / fieldHints() as the dispatcher, so the two surfaces
// cannot drift. krea2 has only 2 subcommands and no advanced flows, so there is
// no `topic` param (unlike flux2_help).

function makeKrea2HelpTool() {
  return defineTool({
    name: "krea2_help",
    label: "Krea 2 Command Reference",
    // Owner-declared gating — mirrored IDENTICALLY from krea2 (same signature)
    // so reconstructOwnerDeclaredGates collapses the two into one multi-name
    // gate {names:["krea2","krea2_help"]} (ticket 06). Co-fire preserved: when
    // the gate fires, both names activate together. See krea2's gating comment.
    gating: {
      keywords: ["krea", "krea2", "草圖", "快速生成", "即時生成", "實時繪圖", "sketch", "real-time", "real time"],
      requires: {
        nouns: ["doodle", "concept", "mockup", "draft", "草稿", "概念"],
        verbs: ["draw", "doodle", "live-draw", "render", "畫", "塗鴉", "速寫"],
      },
    },
    description:
      "On-demand reference for the `krea2` tool. Pass {command} for option keys/defaults/path rules + example; omit to list subcommands.",
    parameters: Type.Object({
      command: Type.Optional(
        COMMAND_ENUM,
      ),
    }),

    async execute(_id, params) {
      let text: string;
      if (params.command) {
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
            (spec.writesImage ? "  (📤 produces an image)" : "  (no image output)") +
            `\n\n${commandExample(cmd)}`;
        }
      } else {
        text =
          "krea2 subcommands (📤 = produces an image):\n" + commandIndex() +
          "\n\nPass command:\"<name>\" for that command's exact option keys, defaults, and path " +
          "rules (+ a worked example). Option-list legend: \"[]\" = array field; \"path\" = " +
          "path-validated against repo/output/models roots; \"(positional)\" = bare positional arg.";
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { ok: true, command: params.command ?? null },
      };
    },
  });
}

// ─── Extension factory ───────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeKrea2Tool());
  pi.registerTool(makeKrea2HelpTool());

  // Promote to default-load (always active) so the agent sees krea2/krea2_help
  // on every turn without tool-search.
  pi.on('session_start', () => {
    const current = pi.getActiveTools();
    if (!current.includes('krea2')) {
      pi.setActiveTools([...new Set([...current, 'krea2', 'krea2_help'])]);
    }
  });
};

/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime `gating`
 * object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Plain object:
 * no `satisfies` / type import, so the extension never depends on tool-gate
 * (avoids a circular dep); shape is enforced by tool-gate's drift-guard test.
 *  - controls[]  carry a current keyword → MUST fire.
 *  - adversarial[] are keyword-free "I need this tool" phrasings that fire via
 *    the noun∧verb `requires` path on the runtime gating. recallFloor 0.9 = the
 *    calibrated target now that the krea2 gate carries a requires path (was 0
 *    when the gate was keywords-only and paraphrased intent could not fire).
 */
export const __GATE_PROBES__ = {
	gate: "krea2",
	recallFloor: 0.9,
	adversarial: ["doodle a quick concept", "live-draw a fast mockup", "快速畫一個草稿"],
	controls: ["sketch the idea", "用 krea2 快速生成", "real-time draw"],
};

export default extension;
