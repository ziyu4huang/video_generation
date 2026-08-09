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

function makeMovieTool() {
  return defineTool({
    name: "movie",
    label: "Movie Director Orchestrator",
    description: ROUTING_DESCRIPTION,
    // Owner-declared gating — migrated from tool-gate's hardcoded GATES (was the
    // {names:["movie","movie_help"]} gate). Per ticket 08's semantics-preserving
    // rule, the SAME gating is mirrored on movie_help so both activate together
    // and reconstructOwnerDeclaredGates collapses them back into one multi-name
    // gate (names[0] === "movie"). Mirrors the original GATES entry verbatim:
    // keywords only (montage/storyboard/分鏡/導演/film phrases) — no `requires`,
    // since these are unambiguous generation intents that never false-fire on
    // bare nouns the way image/video do.
    gating: {
      keywords: [
        "montage", "preflight", "storyboard", "分鏡", "剪輯",
        "影片製作", "導演", "make a movie", "make a film", "movie director",
        "compose video", "compose scene", "電影製作",
        "short film", "into a film", "scenes into",
      ],
    },
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
    // Owner-declared gating — mirrored IDENTICALLY from movie (same signature)
    // so reconstructOwnerDeclaredGates collapses the two into one multi-name
    // gate {names:["movie","movie_help"]} (ticket 08). Co-fire preserved: when
    // the gate fires, both names activate together. See movie's gating comment.
    gating: {
      keywords: [
        "montage", "preflight", "storyboard", "分鏡", "剪輯",
        "影片製作", "導演", "make a movie", "make a film", "movie director",
        "compose video", "compose scene", "電影製作",
        "short film", "into a film", "scenes into",
      ],
    },
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
 * object). Consumed by pi-agent-ext-tool-gate/qa/collect-probes.ts. Plain object:
 * no `satisfies` / type import, so the extension never depends on tool-gate
 * (avoids a circular dep); shape is enforced by tool-gate's drift-guard test.
 *  - controls[]  carry a current keyword → MUST fire.
 *  - adversarial[] are keyword-free "I need this tool" phrasings. NOTE: the
 *    movie gate is keywords-only (no `requires`), so keyword-free paraphrases
 *    CANNOT fire — recall is structurally 0%. This is a REAL FINDING (flagged
 *    for review): the gate cannot match paraphrased intent, only exact
 *    keywords. recallFloor is therefore pinned to the OBSERVED value (0), not
 *    silently to pass — broadening keywords risks false-fires, and adding a
 *    requires path (nouns film/movie/video/片段; verbs assemble/direct/cut/
 *    compose) to the runtime gating is the clean fix but is out of scope for
 *    this QA-data-only change. The adversarial probes stay as genuine-intent
 *    witnesses of the gap.
 */
export const __GATE_PROBES__ = {
	gate: "movie",
	// floor 0 = OBSERVED recall (keywords-only gate, no requires path; see above).
	recallFloor: 0,
	adversarial: [
		"assemble these clips into a short piece",
		"turn the footage into a narrative cut",
		"direct a sequence from these scenes",
		"把這些片段剪成一支作品",
	],
	controls: ["make a movie from these scenes", "compose video from the clips", "做一個分鏡"],
};

export default extension;
