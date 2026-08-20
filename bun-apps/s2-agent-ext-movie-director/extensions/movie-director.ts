/**
 * pi-movie-director — the orchestration extension. ONE dispatcher tool `movie`
 * exposing the pipeline state-machine commands the agent drives.
 *
 * This is NOT a single-CLI wrap (unlike pi-ltx / pi-flux2). It is the
 * orchestration layer: pipeline manifest loading, gate-enforced checkpoints,
 * artifact schema validation, budget governance, and a provider-menu preflight.
 * Media generation itself is delegated (iteration 2+) to the native directors
 * via the registry → existing pi-ext-{krea2,flux2,ltx} + ffmpeg/cloud bridges.
 *
 * The agent IS the intelligence (OpenMontage's instruction-driven model): it
 * reads stage-director skills (MD files under data/skills), uses these commands
 * to advance state, and presents at human-approval gates.
 *
 * The per-command dispatch logic, command table, and reference text live in
 * `src/dispatch.ts` — the SINGLE source shared with the standalone CLI
 * (`src/cli.ts`), so the agent-tool path and the CLI path never drift.
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import {
  COMMAND_ENUM,
  COMMAND_REFERENCE,
  ROUTING_DESCRIPTION,
  coerceOptions,
  commandReferenceBlock,
  dispatch,
  type Command,
} from "../src/dispatch.ts";
import { scopeViolationForToolCall } from "../src/index.ts";
import { markMovieActive } from "../src/session-state.ts";
import { registerMovieHostFns } from "./movie-host-fns.ts";
import { registerMovieWorkflows } from "./movie-workflows.ts";

/**
 * Gate family for the movie-director family — declared ONCE by id (wayfinder
 * ticket 01 reference form); `movie` + `movie_help` both reference it via
 * `gating: { gate: "movie" }`, so buildEffectiveGates groups them into ONE
 * co-firing family gate (names[0] === "movie"). The former shared-object +
 * fingerprint-equality reconstruction is gone — edit the family here, both
 * tools follow.
 *
 * Keywords cover the unambiguous montage/storyboard/分鏡/導演/film phrases; the
 * noun∧verb `requires` path mirrors flux2/ltx so keyword-free paraphrases
 * (assemble clips / cut footage / 剪片段) also reach the gate (gate-recall
 * adversarial floor 0.9 — see __GATE_PROBES__ below).
 */
const MOVIE_GATING = {
  keywords: [
    "montage", "preflight", "storyboard", "分鏡", "剪輯",
    "影片製作", "導演", "make a movie", "make a film", "movie director",
    "compose video", "compose scene", "電影製作",
    "short film", "into a film", "scenes into",
  ],
  requires: {
    nouns: ["clip", "clips", "footage", "scene", "scenes", "sequence", "片段", "畫面", "作品", "影片"],
    verbs: ["assemble", "compose", "direct", "cut", "orchestrate", "edit", "stitch", "剪", "編排", "組裝", "製作"],
  },
};

// Register the family in the shared registry at module load (ticket 01).
GATE_DEFS["movie"] = {
  id: "movie",
  ...MOVIE_GATING,
  description: "Movie director orchestration",
};

function makeMovieTool() {
  return defineTool({
    name: "movie",
    label: "Movie Director Orchestrator",
    description: ROUTING_DESCRIPTION,
    gating: { gate: "movie" }, // reference form (ticket 01) — family in GATE_DEFS["movie"]
    promptSnippet:
      "Instruction-driven video production orchestrator (OpenMontage rewrite). Drives idea→script→scene_plan→assets→edit→compose→publish " +
      "with gate-enforced checkpoints; consumes native krea2/flux2/ltx directors. Call movie_help for the command reference.",
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description: "Per-command options. Call movie_help (command:<name>) for the exact option keys + worked example.",
      }),
    }),
    async execute(_id, params) {
      markMovieActive();
      const opts = coerceOptions(params.options);
      const res = await dispatch(params.command as Command, opts);
      const text = res.ok ? res.text : `movie-director errored: ${res.error}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ok: res.ok, error: res.ok ? undefined : res.error },
      };
    },
  });
}

function makeMovieHelpTool() {
  return defineTool({
    name: "movie_help",
    label: "Movie Director Command Reference",
    gating: { gate: "movie" }, // reference form (ticket 01) — same family as movie
    description:
      "On-demand reference for the `movie` tool. Pass {command} for option keys + example; omit to list all commands.",
    parameters: Type.Object({
      // COMMAND_ENUM is intentionally NOT used here — the main `movie` tool
      // already carries the full command enum in its schema (always co-active
      // with movie_help), so duplicating it here was pure schema tax. A free
      // string + the no-args COMMAND_REFERENCE covers discovery; invalid names
      // return the known list (wayfinder ticket 05 — ~−160 tok/req).
      command: Type.Optional(
        Type.String({
          description:
            "movie subcommand to look up (valid values: the movie tool's `command` enum). " +
            "Omit to list all commands; an unknown name returns the known list.",
        }),
      ),
    }),
    async execute(_id, params) {
      const text = params.command
        ? commandReferenceBlock(params.command)
        : COMMAND_REFERENCE;
      return {
        content: [{ type: "text" as const, text }],
        details: { ok: true, command: params.command ?? null },
      };
    },
  });
}

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeMovieTool());
  pi.registerTool(makeMovieHelpTool());
  // Register movie.* deterministic host-fns with the workflow runtime (if loaded).
  // Lets workflow scripts call('movie.generate', …), call('movie.write-checkpoint', …), etc.
  // No-op when the workflow extension is absent. See extensions/movie-host-fns.ts.
  registerMovieHostFns(pi);
  // Register the movie-director saved workflows (/produce-video, /scene-assets,
  // /research-first, /review-cut) as slash commands. Each runs its .js via
  // runWorkflow with the explicit movie.* host-fn registry. See movie-workflows.ts.
  registerMovieWorkflows(pi, process.cwd());
  // Tool-scope guard: block the built-in edit/write tools when the movie-director
  // agent targets a repo infra root (python/, swift/, …). Prevents the ungrounded
  // edit class observed in the #291 agent-driven run. No-op for non-edit tools.
  // See src/tool-scope.ts for the pure logic + tests.
  pi.on("tool_call", (event) => scopeViolationForToolCall(event));
};

/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of the runtime `gating`
 * object). Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts. Plain object:
 * no `satisfies` / type import, so the extension never depends on tool-gate
 * (avoids a circular dep); shape is enforced by tool-gate's drift-guard test.
 *  - controls[]  carry a current keyword → MUST fire.
 *  - adversarial[] are keyword-free "I need this tool" phrasings that fire via
 *    the noun∧verb `requires` path on the runtime gating. recallFloor 0.9 = the
 *    calibrated target now that the movie gate carries a requires path (was 0
 *    when the gate was keywords-only and paraphrased intent could not fire).
 */
export const __GATE_PROBES__ = {
	gate: "movie",
	recallFloor: 0.9,
	adversarial: [
		"assemble these clips into a short piece",
		"turn the footage into a narrative cut",
		"direct a sequence from these scenes",
		"把這些片段剪成一支作品",
	],
	controls: ["make a movie from these scenes", "compose video from the clips", "做一個分鏡"],
};

export default extension;
