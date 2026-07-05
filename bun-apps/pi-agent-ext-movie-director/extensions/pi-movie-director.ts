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
 */
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  listPipelines,
  loadPipeline,
  getStageOrder,
  getStage,
  getNextStage,
  writeCheckpoint,
  readCheckpoint,
  getLatestCheckpoint,
  getCompletedStages,
  validateArtifact,
  estimate as costEstimate,
  reserve as costReserve,
  reconcile as costReconcile,
  costSnapshot,
  selectProvider,
  selectAndGenerate,
  probedMenuSummary,
  composeVideo,
  finalReview,
  renderRemotion,
  preComposeGate,
  type EditDecisions,
  type RemotionEditDecisions,
  projectDir,
  NoConfiguredProviderError,
  GateViolationError,
  type CheckpointStatus,
} from "../src/index.ts";

const COMMANDS = [
  "preflight",
  "pipeline-list",
  "pipeline-show",
  "init-project",
  "next-stage",
  "write-checkpoint",
  "read-checkpoint",
  "validate-artifact",
  "generate",
  "compose",
  "compose-remotion",
  "pre-compose",
  "final-review",
  "cost-estimate",
  "cost-reserve",
  "cost-reconcile",
  "cost-snapshot",
] as const;
type Command = (typeof COMMANDS)[number];

const COMMAND_ENUM = Type.Union(COMMANDS.map((c) => Type.Literal(c)), {
  description: "movie-director orchestration command.",
});

function coerceOptions(v: unknown): Record<string, unknown> {
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

const DESCRIPTION = [
  "The movie-director orchestration layer — an instruction-driven (agent-first) video production pipeline.",
  "Pure Bun orchestration (pipeline manifests, gate-enforced checkpoints, artifact schema validation, budget",
  "governance, provider preflight) consuming the swift/MLX native directors. Rewrite of OpenMontage.",
  "",
  "Commands:",
  "  • preflight        — provider-menu summary (capabilities configured/available, composition runtimes, gaps).",
  "  • pipeline-list    — available pipeline manifests.",
  "  • pipeline-show    — {pipeline} → stages, approval gates, produces.",
  "  • init-project     — {projectId, pipeline} → create project workspace.",
  "  • next-stage       — {projectId, pipeline, stage?} → next stage + its human-approval policy.",
  "  • write-checkpoint — {projectId, pipeline, stage, status, artifacts?, humanApproved?, ...} ENFORCES THE GATE",
  "                        (status=completed on an approval-gated stage requires humanApproved=true).",
  "  • read-checkpoint  — {projectId, pipeline, stage?} → that stage's checkpoint, or the latest if stage omitted.",
  "  • validate-artifact— {artifact (e.g. 'script'), data} → schema validation against the canonical artifact set.",
  "  • generate         — {capability, command, options?, provider?, projectId?, ...} → selects a configured native director",
  "                        (krea2/flux2/ltx), runs it, returns a ToolResult {success, artifacts[], cost_usd, duration_seconds,",
  "                        seed, model}. When projectId is given, the full estimate→reserve→reconcile cost lifecycle runs and",
  "                        the costEntryId is returned alongside. This is the assets-stage bridge: it actually produces files.",
  "  • compose          — {editDecisions, workDir?, output?, resolution?, fps?} → trims each cut to its",
  "                        [in,out] window and concatenates them into a real .mp4 (ffmpeg straight-cut foundation;",
  "                        transitions/overlays are the templated-composer tier). Returns a render_report.",
  "  • compose-remotion — {editDecisions, workDir?, output?, width?, height?, fps?} → renders the edit through a",
  "                        Remotion composition (templated compose tier): per-cut ken-burns/zoom/pan motion, crossfade",
  "                        transitions, section_title overlays, narration/music audio. editDecisions.cuts carry optional",
  "                        animation/type/text; overlays[] + audio{} + transition + theme drive the composition.",
  "                        Spawns the `remotion` binary (set REMOTION_BIN or install on PATH; falls back to bunx).",
  "                        Returns a render_report (render_grammar:'remotion').",
  "  • pre-compose      — {editDecisions} → deterministic gate BEFORE the expensive render: delivery promise",
  "                        (cuts/duration/sources/audio) + slideshow risk (static-image fraction). {verdict, checks[]}.",
  "  • final-review     — {mp4Path} → 6 delivery checks (container, duration>0, video stream, audio stream,",
  "                        volumedetect, midpoint frame) → {verdict:'pass'|'fail', checks[]}. A fail blocks publish.",
  "  • cost-estimate    — {projectId, tool, operation, estimatedUsd} → entryId.",
  "  • cost-reserve     — {projectId, entryId} → reserves budget (cap mode raises BudgetExceededError).",
  "  • cost-reconcile   — {projectId, entryId, actualUsd, success} → settles the reservation.",
  "  • cost-snapshot    — {projectId} → {total_spent_usd, total_reserved_usd, budget_remaining_usd}.",
].join("\n");

function jsonOut(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

async function dispatch(command: Command, opts: Record<string, unknown>): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    switch (command) {
      case "preflight":
        return { ok: true, text: jsonOut(probedMenuSummary()) };
      case "pipeline-list":
        return { ok: true, text: jsonOut(listPipelines()) };
      case "pipeline-show": {
        const m = loadPipeline(String(opts.pipeline ?? ""));
        return { ok: true, text: jsonOut(m) };
      }
      case "init-project": {
        const projectId = String(opts.projectId ?? "");
        const pipeline = String(opts.pipeline ?? "");
        // Writing an in_progress checkpoint at the first stage creates the dir.
        const order = getStageOrder(pipeline);
        if (order.length === 0) return { ok: false, error: `pipeline "${pipeline}" not loadable` };
        return { ok: true, text: jsonOut({ projectId, pipeline, stages: order, projectDir: `(created on first write-checkpoint)` }) };
      }
      case "next-stage": {
        const pipeline = String(opts.pipeline ?? "");
        const stage = opts.stage ? String(opts.stage) : undefined;
        const order = getStageOrder(pipeline);
        const from = stage ?? order[0];
        const next = stage ? getNextStage(pipeline, from!) : from;
        const stageInfo = next ? getStage(pipeline, next) : undefined;
        return {
          ok: true,
          text: jsonOut({
            current: from,
            next,
            next_human_approval_default: stageInfo?.human_approval_default ?? false,
            next_produces: stageInfo?.produces ?? [],
            next_skill: stageInfo?.skill,
          }),
        };
      }
      case "write-checkpoint": {
        const cp = writeCheckpoint({
          projectId: String(opts.projectId ?? ""),
          pipeline: String(opts.pipeline ?? ""),
          stage: String(opts.stage ?? ""),
          status: String(opts.status ?? "in_progress") as CheckpointStatus,
          artifacts: opts.artifacts as Record<string, unknown> | undefined,
          humanApproved: opts.humanApproved === true,
          review: opts.review,
          costSnapshot: opts.costSnapshot,
          error: opts.error ? String(opts.error) : undefined,
          metadata: opts.metadata as Record<string, unknown> | undefined,
        });
        return { ok: true, text: jsonOut(cp) };
      }
      case "read-checkpoint": {
        const projectId = String(opts.projectId ?? "");
        const pipeline = String(opts.pipeline ?? "");
        const cp = opts.stage ? readCheckpoint(projectId, String(opts.stage)) : getLatestCheckpoint(projectId, pipeline);
        const completed = getCompletedStages(projectId, pipeline);
        return { ok: true, text: jsonOut({ checkpoint: cp ?? null, completedStages: completed }) };
      }
      case "validate-artifact": {
        const name = String(opts.artifact ?? "");
        const v = validateArtifact(name, opts.data);
        return { ok: true, text: jsonOut(v) };
      }
      case "generate": {
        const capability = String(opts.capability ?? "") as
          | "image_generation"
          | "video_generation"
          | "tts"
          | "music_generation"
          | "video_post"
          | "audio_processing"
          | "analysis"
          | "enhancement"
          | "subtitle"
          | "composition";
        if (!capability) return { ok: false, error: "generate requires {capability}" };
        const projectId = opts.projectId ? String(opts.projectId) : undefined;
        const provider = opts.provider ? String(opts.provider) : undefined;
        const operation = opts.operation ? String(opts.operation) : `${capability}:${opts.command ?? ""}`;

        // Pre-resolve the selector so a no-configured-provider error is a clean
        // structured failure (not a thrown stack trace) and so we know the
        // entry before deciding whether to run the cost lifecycle.
        let entry;
        try {
          entry = selectProvider(capability, { provider });
        } catch (err) {
          if (err instanceof NoConfiguredProviderError) {
            return { ok: false, error: err.message };
          }
          throw err;
        }

        // Cost lifecycle: estimate → reserve → generate → reconcile. Only when a
        // projectId is given (governance is per-project). Best-effort: a cost
        // failure must NOT mask the generation result.
        let costEntryId: string | undefined;
        if (projectId) {
          const estimated = Number(opts.estimatedUsd ?? 0);
          try {
            costEntryId = costEstimate(projectId, entry.provider, operation, estimated);
            costReserve(projectId, costEntryId);
          } catch {
            // observe mode never throws; in cap mode a budget breach SHOULD block.
            costEntryId = undefined;
          }
        }

        const { result } = await selectAndGenerate(
          capability,
          {
            command: String(opts.command ?? ""),
            options: opts.options as Record<string, unknown> | undefined,
            outputDir: opts.outputDir ? String(opts.outputDir) : undefined,
            modelsRoot: opts.modelsRoot ? String(opts.modelsRoot) : undefined,
            extraArgs: opts.extraArgs as string[] | undefined,
          },
          { provider },
        );

        if (projectId && costEntryId) {
          try {
            costReconcile(projectId, costEntryId, result.cost_usd, result.success);
          } catch {
            /* best-effort: don't mask the generation result */
          }
        }

        return {
          ok: true,
          text: jsonOut({ provider: entry.provider, invoke: entry.invoke, costEntryId: costEntryId ?? null, result }),
        };
      }
      case "compose": {
        const edit = opts.editDecisions as EditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "compose requires {editDecisions:{version,cuts:[...]}}" };
        }
        const workDir = opts.workDir ? String(opts.workDir) : projectDir(String(opts.projectId ?? "_compose"));
        const report = await composeVideo(edit, {
          workDir,
          output: opts.output ? String(opts.output) : undefined,
          resolution: opts.resolution ? String(opts.resolution) : undefined,
          fps: opts.fps ? Number(opts.fps) : undefined,
        });
        return { ok: true, text: jsonOut(report) };
      }
      case "compose-remotion": {
        const edit = opts.editDecisions as RemotionEditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "compose-remotion requires {editDecisions:{version,cuts:[...]}}" };
        }
        const workDir = opts.workDir ? String(opts.workDir) : projectDir(String(opts.projectId ?? "_compose_remotion"));
        const report = await renderRemotion(edit, {
          workDir,
          output: opts.output ? String(opts.output) : undefined,
          width: opts.width ? Number(opts.width) : undefined,
          height: opts.height ? Number(opts.height) : undefined,
          fps: opts.fps ? Number(opts.fps) : undefined,
        });
        return { ok: true, text: jsonOut(report) };
      }
      case "pre-compose": {
        const edit = opts.editDecisions as RemotionEditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "pre-compose requires {editDecisions:{version,cuts:[...]}}" };
        }
        const gate = preComposeGate(edit);
        return { ok: true, text: jsonOut(gate) };
      }
      case "final-review": {
        const mp4 = String(opts.mp4Path ?? opts.path ?? "");
        if (!mp4) return { ok: false, error: "final-review requires {mp4Path}" };
        const review = await finalReview(mp4);
        return { ok: true, text: jsonOut(review) };
      }
      case "cost-estimate": {
        const id = costEstimate(String(opts.projectId ?? ""), String(opts.tool ?? ""), String(opts.operation ?? ""), Number(opts.estimatedUsd ?? 0));
        return { ok: true, text: jsonOut({ entryId: id }) };
      }
      case "cost-reserve": {
        costReserve(String(opts.projectId ?? ""), String(opts.entryId ?? ""));
        return { ok: true, text: jsonOut({ reserved: true }) };
      }
      case "cost-reconcile": {
        costReconcile(String(opts.projectId ?? ""), String(opts.entryId ?? ""), Number(opts.actualUsd ?? 0), opts.success !== false);
        return { ok: true, text: jsonOut({ reconciled: true }) };
      }
      case "cost-snapshot": {
        return { ok: true, text: jsonOut(costSnapshot(String(opts.projectId ?? ""))) };
      }
      default:
        return { ok: false, error: `unknown command: ${command}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function makeMovieTool() {
  return defineTool({
    name: "movie",
    label: "Movie Director Orchestrator",
    description: DESCRIPTION,
    promptSnippet:
      "Instruction-driven video production orchestrator (OpenMontage rewrite). Drives idea→script→scene_plan→assets→edit→compose→publish " +
      "with gate-enforced checkpoints; consumes native krea2/flux2/ltx directors.",
    parameters: Type.Object({
      command: COMMAND_ENUM,
      options: Type.Any({
        description: "Per-command options (see the command reference in this tool's description).",
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

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(makeMovieTool());
};

export default extension;
