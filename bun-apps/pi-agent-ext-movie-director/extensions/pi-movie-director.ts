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

function makeMovieTool() {
  return defineTool({
    name: "movie",
    label: "Movie Director Orchestrator",
    description: ROUTING_DESCRIPTION,
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
    description:
      "On-demand reference for the `movie` tool. Pass {command} for option keys + example; omit to list all commands.",
    parameters: Type.Object({
      command: Type.Optional(COMMAND_ENUM),
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
  // Tool-scope guard: block the built-in edit/write tools when the movie-director
  // agent targets a repo infra root (python/, swift/, …). Prevents the ungrounded
  // edit class observed in the #291 agent-driven run. No-op for non-edit tools.
  // See src/tool-scope.ts for the pure logic + tests.
  pi.on("tool_call", (event) => scopeViolationForToolCall(event));
};

export default extension;
