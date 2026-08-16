/**
 * pi-flux2 — wraps the `swift/flux2-image-director` CLI (flux2) as ONE agent-
 * optimized tool PLUS a cheap `flux2_help` companion.
 *
 * Design: TWO tools, on the Tool-Search / Lazy-Loading pattern.
 *
 *   • `flux2` — the dispatcher. The agent picks `command` (one of 18 flux2
 *     subcommands) and passes typed `options` (camelCase keys). Its
 *     `description` is intentionally SHORT (~150 tok): only what the model
 *     needs for ROUTING (what flux2 is, the 18-subcommand index, the
 *     `details.output` chaining convention). The heavy per-command field
 *     reference is NOT embedded here — it is far too expensive to ship on
 *     every turn.
 *
 *   • `flux2_help` — an on-demand reference tool (~120 tok schema). The model
 *     calls it only when it needs a command's exact option keys / defaults /
 *     path rules, or the multi-seed scene-pipeline / self-improve-loop docs.
 *     Its output is a tool RESULT (lives in conversation history, not the
 *     static schema), so the heavy text appears only in the turn where it is
 *     requested. It reads the SAME `COMMANDS` spec / `fieldHints()` as the
 *     dispatcher, so it can never drift from what the CLI actually accepts.
 *
 * The dispatcher still:
 *   • resolves / auto-builds the Swift binary,
 *   • validates every image/model path against allowed roots (anti-argv-injection),
 *   • streams progress and honors abort,
 *   • parses the .manifest.json sidecar into structured `details` (output path,
 *     dimensions, seed, gate verdict, perf) so the agent can chain steps, and
 *     auto-runs `flux2 gate` on every generation to surface a quality verdict.
 *
 * Load (source mode):
 *   bun bun-apps/pi-agent/src/cli.ts -e bun-apps/pi-agent-ext-flux2/extensions/flux2.ts -p "..."
 * Bundle:
 *   bun scripts/build-bundle.ts  →  dist/pi-extensions/pi-agent-ext-flux2.bundle.js
 *
 * Env overrides: FLUX2_BIN, FLUX2_REPO_ROOT, MLX_OUTPUT_DIR, MLX_MODELS_DIR.
 */
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";
import {
  COMMANDS,
  COMMAND_LIST,
  runFlux2,
  PathSafetyError,
  type CommandName,
  type Flux2Details,
} from "../src/index.ts";

// ─── Gate family (wayfinder ticket 01 — reference form) ─────────────────────
// Declared ONCE by id; flux2 + flux2_help both reference it via
// `gating: { gate: "flux2" }`. buildEffectiveGates groups the two into ONE
// co-firing family gate (names[0] === "flux2") — the former per-tool verbatim
// duplication (Spec-B hazard) is gone; edit the family here, both tools follow.
GATE_DEFS["flux2"] = {
  id: "flux2",
  keywords: [
    "flux", "flux2", "outpaint", "upscale image", "t2i", "txt2img",
    "圖像", "圖片", "生成圖", "產圖", "繪圖", "修圖", "去背", "換臉",
    "做成圖", "轉成圖",
  ],
  requires: {
    nouns: ["image", "picture", "photo", "圖片", "圖像", "照片", "相片"],
    verbs: ["generate", "create", "make", "draw", "render", "produce", "生成", "做", "畫", "繪"],
  },
  description: "FLUX.2 image generation",
};

// ─── On-demand reference builders (shared by the slim description + help tool) ─
//
// These are the SINGLE source of the per-command field reference. The slim
// `flux2` description only embeds the cheap index (commandIndex); the heavy
// per-command block (fieldHints) + the scene-pipeline / self-improve docs live
// behind `flux2_help`, which calls these same functions. Editing a field in
// src/commands.ts therefore updates BOTH surfaces at once — no drift.

/** Per-command field reference (teaches the agent the exact option keys). */
function fieldHints(cmdName: CommandName): string {
  const spec = COMMANDS[cmdName];
  // cmdName is a CommandName (keyof COMMANDS), so the lookup is defined.
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
/**
 * Terse routing tags shown in the always-on description + the flux2_help "list
 * all" view. The full `when` sentence + per-field reference stay in
 * flux2_help's per-command path (fieldHints). Falls back to `when` if untagged.
 */
const SUBCOMMAND_TAGS: Record<string, string> = {
  "t2i": "Text → image (basic gen)",
  "scene": "Multi-character scene compose",
  "edit": "Reference-conditioned edit",
  "style": "Identity-preserving style transfer",
  "kv-style-transfer": "K/V-injection style transfer",
  "angle": "Multi-angle character views",
  "swap": "Swap object via reference",
  "expand": "Outpaint / expand canvas",
  "upscale": "4× super-resolution",
  "gate": "Score images (no generation)",
  "segment": "SAM3 segmentation → mask",
  "story": "One character, many scenes",
  "models": "List installed models (read-only)",
  "verify-vae": "Diagnostic: VAE vs reference",
  "verify-encoder": "Diagnostic: encoder vs reference",
  "verify-tokenizer": "Diagnostic: tokenizer vs reference",
  "verify-transformer": "Diagnostic: transformer vs reference",
  "verify-e2e": "Diagnostic: full denoise vs reference",
  "verify-edit": "Diagnostic: edit conditioning vs reference",
};

function commandIndex(): string {
  return COMMAND_LIST.map(
    (c) => `  • ${c.name}${c.writesImage ? " 📤" : ""} — ${SUBCOMMAND_TAGS[c.name] ?? c.when}`,
  ).join("\n");
}

/** Exact per-command field-reference block (same text the old description embedded). */
function commandFieldBlock(cmdName: CommandName): string {
  return `── ${cmdName} ──\n${fieldHints(cmdName)}`;
}

/** Multi-seed scene-pipeline reference (deferred to flux2_help). */
function scenePipelineDoc(): string {
  return (
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
    "(default: lm-studio/google/gemma-4-12b).\n" +
    "  • handRepairWinner (boolean, optional) — re-render the winning seed once more with " +
    "--hand-repair.\n" +
    "Result: `details.output` is the winner's (or hand-repaired winner's) PNG path — chains " +
    "exactly like a single scene call. `details.scenePipeline.candidates[]` has every seed's " +
    "output/gate/VLM verdict for inspection."
  );
}

/** Self-improve loop reference (deferred to flux2_help). */
function selfImproveDoc(): string {
  return (
    "── Self-improve loop (generate→judge→reflect→retry) ──\n" +
    "If the user asks to GENERATE AND IMPROVE / SELF-IMPROVE / iterate until good (e.g. " +
    "\"generate + improve a dancer's pose until the anatomy is right\"), do NOT loop single " +
    "flux2 calls yourself — instead run the closed loop, which judges each attempt with the " +
    "atomic pose_dsg validator and feeds failed atoms back into the next prompt:\n" +
    "  bash bun-apps/pi-agent/scripts/run-self-improve-loop.sh --pose-id <id|L1-01..L4-02> " +
    "[--attempts N] [--seed S] [--steps N]   # pose library → pose_dsg judging\n" +
    "  bash bun-apps/pi-agent/scripts/run-self-improve-loop.sh --prompt \"<text>\"            " +
    "# non-pose → holistic score judging\n" +
    "Poses live in bun-apps/pi-agent-ext-flux2/workflows/poses.json. The runner prints a " +
    "structured result (converged, attemptsUsed, winnerPath, needsReview) — report it " +
    "faithfully. It spends real GPU+VLM tokens, so invoke it ONCE and reuse its winnerPath " +
    "(chain `upscale` on that path if useful)."
  );
}

/** One concise worked example per command (illustrative; fieldHints is authoritative). */
const COMMAND_EXAMPLES: Partial<Record<CommandName, string>> = {
  t2i: 'flux2({command:"t2i", options:{prompt:"a red panda eating bamboo, studio light", seed:42, width:1024, height:1024}})',
  scene: 'flux2({command:"scene", options:{prompt:"two characters sitting in a classroom", ref:["alice.png","bob.png"], seed:7}})  → then chain details.output into flux2 upscale',
  edit: 'flux2({command:"edit", options:{prompt:"add sunglasses", images:["face.png"]}})',
  style: 'flux2({command:"style", options:{input:"anime_girl.png", preset:"anime2real", refCount:3}})',
  "kv-style-transfer": 'flux2({command:"kv-style-transfer", options:{prompt:"a cat in a forest", styleImage:"monet.png", strength:0.8}})',
  angle: 'flux2({command:"angle", options:{input:"hero.png", angle:"right-high", refCount:3}})',
  swap: 'flux2({command:"swap", options:{source:"scene.png", reference:"product.png", prompt:"the coffee mug"}})',
  expand: 'flux2({command:"expand", options:{input:"portrait.png", expand:"all", pixels:128}})',
  upscale: 'flux2({command:"upscale", options:{input:"out.png"}})  → 4x super-resolution',
  gate: 'flux2({command:"gate", options:{images:["out.png"], json:true}})  → quality verdict, no generation',
  segment: 'flux2({command:"segment", options:{image:"out.png", prompt:"woman\'s face"}})  → mask PNG',
  story: 'flux2({command:"story", options:{character:"a young woman with red hair in armor", scenes:"right:walking through forest,front-high:standing on a cliff"}})',
  models: 'flux2({command:"models", options:{}})  → list installed model variants (read-only)',
};

function commandExample(cmdName: CommandName): string {
  const ex = COMMAND_EXAMPLES[cmdName];
  if (ex) return `Example:\n  ${ex}`;
  return "Example:\n  (diagnostic command — see option list above; pass the --ref path and a threshold).";
}

/** Slim (~150 tok) description: routing info only. Heavy reference → flux2_help. */
function buildDescription(): string {
  // Stealth-trimmed: routing one-liner only. Bulk semantics (18-subcommand
  // list, per-command option keys/defaults/path rules, scene-pipeline +
  // self-improve topics) live in the on-demand `flux2_help` tool result —
  // never the static schema. Trimming saved ~450 tok/req (descLen 2020 -> ~205).
  return (
    "Generate/edit/gate images via the Flux2 Klein model (Swift/MLX). Pass `command` + `options` " +
    "(camelCase). Call `flux2_help({command})` for option keys/defaults/path rules, or `flux2_help` " +
    "with no args to list subcommands."
  );
}

const COMMAND_ENUM = StringEnum(COMMAND_LIST.map((c) => c.name), {
  description: "flux2 subcommand to run.",
});

const HELP_TOPIC_ENUM = StringEnum(["scene-pipeline", "self-improve"] as const, {
  description: "Reference topic to look up instead of a single command.",
});

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
    // Owner-declared gating — reference form (wayfinder ticket 01): the family
    // is declared once in GATE_DEFS["flux2"] above; both flux2 + flux2_help
    // reference it so buildEffectiveGates groups them into one co-firing gate
    // (names[0] === "flux2") — preserving the original co-fire behavior.
    gating: { gate: "flux2" },
    // promptSnippet + promptGuidelines REMOVED (stealth): usage is taught via
    // the routing description + the on-demand flux2_help tool, not per-turn
    // system-prompt injection.
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description:
          "Object of camelCase options for the chosen command. Only options valid for `command` " +
          "are read. Get the exact keys/defaults/path rules from flux2_help({command}). Paths " +
          "must be under an allowed root.",
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
              description: "One render per seed, in order. Required to trigger the pipeline.",
            }),
            verifyPrompt: Type.Optional(
              Type.String({ description: "VLM question about each candidate." }),
            ),
            verifyMatch: Type.Optional(
              Type.Array(Type.String(), {
                description: "Substrings that must ALL appear in a candidate's VLM reply to win.",
              }),
            ),
            vlmModel: Type.Optional(
              Type.String({ description: "VLM subagent model override." }),
            ),
            handRepairWinner: Type.Optional(
              Type.Boolean({ description: "Re-render the winner once more with --hand-repair." }),
            ),
          },
          {
            description:
              "Only when command is 'scene': render across multiple seeds, gate + optionally VLM-verify " +
              "each, return the winner as details.output. Full docs: flux2_help({topic:\"scene-pipeline\"}).",
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
          onProgress: (u) =>
            onUpdate?.({
              content: [{ type: "text", text: u.text }],
              // A progress update is a PARTIAL result streamed mid-execution;
              // the full Flux2Details aren't known until the process exits. The
              // SDK's AgentToolUpdateCallback<T> requires an AgentToolResult<T>
              // (content + details), and its own bash tool passes `details:
              // undefined` for the same reason — only `content` is rendered for
              // streaming updates. Cast satisfies the shape without lying about
              // details that don't exist yet.
              details: undefined as unknown as Flux2Details,
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
              text: (isSafety ? "flux2 rejected (path-safety): " : "flux2 errored: ") + msg,
            },
          ],
          details: { ok: false, error: msg, pathSafety: isSafety },
        };
      }
    },
  });
}

// ─── The on-demand help tool (~120 tok schema) ───────────────────────────────
//
// A tool RESULT (lives in conversation history), so the heavy per-command
// reference appears only in the turn it is requested — never in the static
// schema. Reads the SAME COMMANDS spec / fieldHints() as the dispatcher, so the
// two surfaces cannot drift.

function makeFlux2HelpTool() {
  return defineTool({
    name: "flux2_help",
    label: "Flux2 Command Reference",
    // Owner-declared gating — reference form: same GATE_DEFS["flux2"] family as
    // the flux2 dispatcher, so the two co-fire together (ticket 01).
    gating: { gate: "flux2" },
    description:
      "On-demand reference for the `flux2` tool. Pass {command} for option keys/defaults/path rules + example; omit args to list subcommands; {topic} for scene-pipeline / self-improve.",
    parameters: Type.Object({
      // COMMAND_ENUM is intentionally NOT used here — the main `flux2` tool
      // already carries the full command enum in its schema (always co-active
      // with flux2_help), so duplicating it here was pure schema tax. A free
      // string + the no-args listing covers discovery; invalid names return the
      // known list (wayfinder ticket 05 — ~−180 tok/req).
      command: Type.Optional(
        Type.String({
          description:
            "flux2 subcommand to look up (valid values: the flux2 tool's `command` enum). " +
            "Omit to list all subcommands; an unknown name returns the known list.",
        }),
      ),
      topic: Type.Optional(HELP_TOPIC_ENUM),
    }),

    async execute(_id, params) {
      let text: string;
      if (params.topic) {
        text =
          params.topic === "scene-pipeline" ? scenePipelineDoc() : selfImproveDoc();
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
            (spec.writesImage ? "  (📤 produces an image)" : "  (no image output)") +
            `\n\n${commandExample(cmd)}`;
        }
      } else {
        text =
          "flux2 subcommands (📤 = produces an image):\n" + commandIndex() +
          "\n\nPass command:\"<name>\" for that command's exact option keys, defaults, and path " +
          "rules (+ a worked example). Pass topic:\"scene-pipeline\" or topic:\"self-improve\" " +
          "for those flows. Option-list legend: \"[]\" = array field; \"path\" = path-validated " +
          "against repo/output/models roots; \"(positional)\" = bare positional arg.";
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
  pi.registerTool(makeFlux2Tool());
  pi.registerTool(makeFlux2HelpTool());

  // Promote to default-load (always active) so the agent sees flux2/flux2_help
  // on every turn without tool-search. This is a deliberate deviation from the
  // Tool-Search / Lazy-Loading design header above — the project standard is
  // default-load for generation tools that get called often.
  pi.on('session_start', () => {
    const current = pi.getActiveTools();
    if (!current.includes('flux2')) {
      pi.setActiveTools([...new Set([...current, 'flux2', 'flux2_help'])]);
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
	gate: "flux2",
	recallFloor: 0.9,
	adversarial: [
		"render the scene you described as a picture",
		"draw the scene you outlined as an image",
		"produce a picture of that concept",
		"把這段描述做成一張照片",
	],
	controls: ["generate an image of a cat", "txt2img a landscape", "用 flux2 產圖"],
};

export default extension;
