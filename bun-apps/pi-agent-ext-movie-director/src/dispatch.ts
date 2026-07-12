/**
 * dispatch.ts — the single orchestration dispatch surface.
 *
 * Pure Bun (no pi-SDK dependency), shared by BOTH consumers of the
 * movie-director command set:
 *
 *   • the pi extension (`extensions/pi-movie-director.ts`) — wraps `dispatch`
 *     in the `movie` tool + a `movie_help` reference tool.
 *   • the standalone CLI (`src/cli.ts`) — exposes each command as a direct,
 *     deterministic, no-LLM top-level command.
 *
 * Extracting the command table + per-command logic here means the two surfaces
 * can NEVER drift: a fix to one command's gating/validation/option handling
 * lands once and applies to both the agent-driven tool path and the CLI path.
 *
 * Layering: imports from the leaf core modules only (pipeline / checkpoint /
 * schema / cost / selector / bridge / compose / …), so `src/index.ts` may
 * re-export this file without creating an import cycle.
 */
import { join } from "node:path";
import { Type } from "typebox";

import {
  listPipelines,
  loadPipeline,
  getStageOrder,
  getStage,
  getNextStage,
} from "./pipeline.ts";
import {
  writeCheckpoint,
  readCheckpoint,
  getLatestCheckpoint,
  getCompletedStages,
  listProjects,
  GateViolationError,
  enforceStageCheckpointGate,
  type CheckpointStatus,
} from "./checkpoint.ts";
import { validateArtifact } from "./schema.ts";
import {
  estimate as costEstimate,
  reserve as costReserve,
  reconcile as costReconcile,
  retagTool,
  costSnapshot,
  BudgetExceededError,
  ApprovalRequiredError,
} from "./cost.ts";
import { recordDecision, getDecisionLog } from "./decision-log.ts";
import { selectProvider, NoConfiguredProviderError } from "./selector.ts";
import { selectAndGenerate } from "./bridge.ts";
import { probedMenuSummary } from "./providers.ts";
import { projectDir } from "./paths.ts";
import { composeVideo, finalReview, type EditDecisions } from "./compose.ts";
import { renderRemotion, type RemotionEditDecisions } from "./remotion.ts";
import { composeMotion, type MotionDeps } from "./compose_motion.ts";
import { preComposeGate, enforcePreCompose } from "./precompose-gate.ts";

/** The canonical 19 orchestration commands (also the CLI's command surface). */
export const COMMANDS = [
  "preflight",
  "pipeline-list",
  "pipeline-show",
  "init-project",
  "list-projects",
  "next-stage",
  "write-checkpoint",
  "read-checkpoint",
  "validate-artifact",
  "generate",
  "compose",
  "compose-remotion",
  "compose-motion",
  "pre-compose",
  "final-review",
  "cost-estimate",
  "cost-reserve",
  "cost-reconcile",
  "cost-snapshot",
  "read-decision-log",
] as const;
export type Command = (typeof COMMANDS)[number];

export const COMMAND_ENUM = Type.Union(COMMANDS.map((c) => Type.Literal(c)), {
  description: "movie-director orchestration command.",
});

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

export const COMMAND_REFERENCE = [
  "The movie-director orchestration layer — an instruction-driven (agent-first) video production pipeline.",
  "Pure Bun orchestration (pipeline manifests, gate-enforced checkpoints, artifact schema validation, budget",
  "governance, provider preflight) consuming the swift/MLX native directors. Rewrite of OpenMontage.",
  "",
  "Commands:",
  "  • preflight        — provider-menu summary (capabilities configured/available, composition runtimes, gaps).",
  "  • pipeline-list    — available pipeline manifests.",
  "  • pipeline-show    — {pipeline} → stages, approval gates, produces.",
  "  • init-project     — {projectId, pipeline} → project workspace: stages + the resolved projectDir + assetsDir.",
  "                        Pass assetsDir as `outputDir` to `generate` so produced files land inside the project workspace.",
  "  • list-projects    — {} (no options) → every discoverable project under MLX_OUTPUT_DIR/movie-director/projects/,",
  "                        derived purely from on-disk checkpoint_*.json files (pipeline, latestStage, latestStatus,",
  "                        completedStages, resumeStage), sorted newest-first. Use this FIRST when resuming after a",
  "                        crash/restart and you don't already know the exact projectId — there is no other way to",
  "                        enumerate in-flight projects.",
  "  • next-stage       — {projectId, pipeline, stage?} → next stage + its human-approval policy.",
  "                        ENFORCED GATE: if `stage` (the CURRENT stage) has checkpoint_required:true in the pipeline",
  "                        manifest, this call refuses (GATE VIOLATION) unless a checkpoint with status=\"completed\" ",
  "                        already exists for it — closes the gap where an agent could work through several",
  "                        checkpoint_required stages (research→...→assets) without ever calling write-checkpoint,",
  "                        leaving zero resumable state if the run crashes (two real kernel panics under sustained GPU",
  "                        load lost full multi-hour runs this way, 2026-07-12). projectId is required whenever `stage`",
  "                        is a checkpoint_required stage. Pass overrideStageGate:true to skip this check explicitly.",
  "  • write-checkpoint — {projectId, pipeline, stage, status, artifacts?, humanApproved?, overrideFinalReview?,",
  "                        overrideRequiredArtifacts?, overrideArtifactValidation?, ...}",
  "                        ENFORCES THE GATE: status=completed on an approval-gated stage requires humanApproved=true;",
  "                        status=completed on a stage requiring the final_review artifact (publish) is rejected when",
  "                        the linked final_review.verdict is 'fail', unless overrideFinalReview=true is passed explicitly;",
  "                        status=completed on a stage whose `required_artifacts_in` (manifest) names an artifact with no",
  "                        completed producing-stage checkpoint is rejected (e.g. compose completing without a completed",
  "                        edit_decisions from edit), unless overrideRequiredArtifacts=true is passed explicitly;",
  "                        status=completed is rejected when any artifact in `artifacts` fails its own canonical schema",
  "                        (e.g. a malformed research_brief/proposal_packet) — the per-field errors are returned, unless",
  "                        overrideArtifactValidation=true is passed explicitly. Run validate-artifact first to fix errors",
  "                        before writing; don't reach for the override to bypass a fixable schema mismatch.",
  "  • read-checkpoint  — {projectId, pipeline, stage?} → that stage's checkpoint, or the latest if stage omitted.",
  "  • validate-artifact— {artifact (e.g. 'script'), data} → schema validation against the canonical artifact set.",
  "  • generate         — {capability, command, options?, provider?, projectId?, ...} → selects a configured native director",
  "                        (krea2/flux2/ltx), runs it, returns a ToolResult {success, artifacts[], cost_usd, duration_seconds,",
  "                        seed, model}. When projectId is given, the full estimate→reserve→reconcile cost lifecycle runs and",
  "                        the costEntryId is returned alongside. Optionally pass `pipeline` to seed a brand-new project's",
  "                        budget from that pipeline's orchestration.budget_default_usd (only applies the first time a cost",
  "                        log is created for the project; ignored once one exists). This is the assets-stage bridge: it",
  "                        actually produces files.",
  "                        capability:'analysis' — `command` selects the analysis subcommand (whisper owns `transcribe`, clip",
  "                        owns `video_understand`). For VISUAL content analysis (what is shown on screen) use",
  "                        command:'video_understand' options:{video, prompt, labels?, numFrames?, model?} → CLIP",
  "                        (openai/clip-vit-base-patch32, local torch MPS, $0) scores each sampled frame against `prompt`",
  "                        (`prompt` is always label[0]; pass `labels` for multi-way ranking; artifacts: clip_scores.json + frames).",
  "                        For AUDIO transcription use command:'transcribe' options:{audio, model?, language?} → mlx-whisper",
  "                        transcript + word-level timestamps (artifacts: transcript.txt, words.json). Feed words.json → subtitle_gen",
  "                        cues → compose {captions:{srtPath, burn?}} to burn captions; pass transcript.txt to final-review for",
  "                        the advisory spoken-content check. capability:'subtitle' options:{wordsPath, cueMode?, wordsPerCue?, cues?}",
  "                        → SRT/VTT; pass the transcribe words.json as `wordsPath` and subtitle_gen derives cues itself (the",
  "                        agent-driven captions path needs no timestamp math). `cues` may also be supplied directly.",
  "                        capability:'video_generation' options:{prompt, image?, frames?, fps?, action?, ...} → I2V/T2V.",
  "                        `frames` is the ONLY duration control (default is short, ~4s worth) — clip length = frames/fps,",
  "                        NOT out_seconds in a later edit_decisions cut. A cut's `out_seconds - in_seconds` can only be as",
  "                        long as the source clip's real (frames/fps) duration; asking compose-motion/-remotion for more",
  "                        just freeze-extends the last frame (silently, no error — pre-compose's `cut_duration_vs_source`",
  "                        check catches this before the render). Pass frames explicitly for the actual wanted duration,",
  "                        e.g. options:{..., frames:200, fps:25} for an 8s clip. Practical ceiling on this hardware is",
  "                        ~8-10s per call (~200-240 frames @24-25fps) — going longer per call fights the model and risks",
  "                        motion-quality degradation. When a scene's script-planned duration is LONGER than one practical",
  "                        call, do NOT force a single oversized call and do NOT pad the remainder with a static/panned",
  "                        still image (pre-compose's `motion_coverage_vs_scene` check flags exactly this). Instead CHAIN",
  "                        multiple real I2V calls: generate clip 1 from the scene's T2I still, extract clip 1's LAST FRAME",
  "                        as a PNG (ffmpeg -sseof -1 -i clip1.mp4 -frames:v 1 lastframe.png), feed that frame back in as",
  "                        `image` for clip 2 (continuing the same motion prompt), repeat until the scene's real generated",
  "                        motion covers its full planned duration, then add each clip as its own consecutive `type:'video'`",
  "                        cut in edit_decisions (cut-s3a 0-8s, cut-s3b 8-16s, ...) — a real take stitched from real",
  "                        sub-takes, not one take padded with a still.",
  "                        capability:'tts' options:{text, voice?, rate?, output?} → narration audio (provider selection",
  "                        tries edge-tts first, falls back to macOS `say`). Pass `rate` (say: words-per-minute, ~140-220",
  "                        natural) through THIS tracked path if you need to control speaking pace — do NOT shell out to",
  "                        raw `bash`+`say`/`edge-tts`, which bypasses cost tracking AND any pacing gate entirely (this is",
  "                        exactly how the saturn-young-rings run's narration-compression bug happened, 2026-07-12: three",
  "                        escalating raw `say -r` calls with no visibility anywhere in the pipeline). THE CAUSALITY RUNS",
  "                        ONE WAY: the script's natural-paced narration length determines the video's length (chain more",
  "                        I2V clips to match it — see the video_generation chaining guidance above); never compress the",
  "                        narration rate to force-fit a video length decided first. write-checkpoint on a stage carrying a",
  "                        `script` artifact auto-computes metadata.script_pacing (words-per-second per section + overall,",
  "                        advisory warn/fail against natural-speech bounds) — check it BEFORE locking total_duration_seconds",
  "                        and generating TTS, not after.",
  "  • compose          — {editDecisions, workDir?, output?, resolution?, fps?, captions?, narrativeDurationSeconds?,",
  "                        overridePreCompose?} → trims each cut to its [in,out] window and concatenates them into a real",
  "                        .mp4 (ffmpeg straight-cut foundation; transitions/overlays are the templated-composer tier).",
  "                        captions:{srtPath, burn?} (burn default true) hard-burns or sidecars an SRT — typically",
  "                        subtitle_gen output from whisper word timestamps. ENFORCES THE SAME pre-compose GATE as",
  "                        compose-remotion/compose-motion below — refuses to render on a fail verdict (e.g. zero cuts,",
  "                        excessive frozen-frame extension) unless overridePreCompose=true is passed explicitly.",
  "  • compose-remotion — {editDecisions, workDir?, output?, width?, height?, fps?, narrativeDurationSeconds?,",
  "                        overridePreCompose?} → renders the edit through a Remotion composition (templated compose",
  "                        tier): per-cut ken-burns/zoom/pan motion, crossfade transitions, section_title overlays,",
  "                        narration/music audio. editDecisions.cuts carry optional animation/type/text; overlays[] +",
  "                        audio{} + transition + theme drive the composition.",
  "                        Spawns the `remotion` binary (set REMOTION_BIN or install on PATH; falls back to bunx).",
  "                        Returns a render_report (render_grammar:'remotion').",
  "  • compose-motion   — {editDecisions, workDir?, output?, width?, height?, fps?, transitionSeconds?,",
  "                        narrativeDurationSeconds?, overridePreCompose?} → renders the edit through the ffmpeg motion",
  "                        compositor (Item J lightweight tier): per-cut ken-burns/zoom/pan via ffmpeg `zoompan` + `xfade`",
  "                        crossfade transitions. Same editDecisions shape as compose-remotion, but no React/browser/swift",
  "                        — callable wherever ffmpeg+zoompan+xfade resolve. Use this when compose-remotion's binary",
  "                        doesn't resolve (the agent-driven default for motion on this machine).",
  "                        Returns a render_report (render_grammar:'motion').",
  "                        ENFORCED GATE (both compose-remotion and compose-motion): before rendering, the SAME",
  "                        pre-compose check below runs internally against editDecisions — a `fail` verdict is refused",
  "                        (no render, {ok:false,error:...} listing the failed checks), not just advisory. Pass",
  "                        narrativeDurationSeconds here too if you want narrative_duration_vs_script enforced (its own",
  "                        `pre-compose` call is now optional — a preview, not a prerequisite — since these two commands",
  "                        run the check themselves). Only overridePreCompose:true bypasses a fail, and only after an",
  "                        explicit human/agent decision to ship past it — a `warn` verdict never blocks either way.",
  "  • pre-compose      — {editDecisions, narrativeDurationSeconds?} → deterministic gate BEFORE the expensive render:",
  "                        delivery promise (cuts/duration/sources/audio) + slideshow risk (static-image fraction) +",
  "                        cut_duration_vs_source (a video cut requesting more than its source clip's real duration —",
  "                        flags the frozen-frame-extension footgun described under generate/video_generation above).",
  "                        IMPORTANT: editDecisions.render_runtime MUST be set to the value you'll actually compose with",
  "                        ('ffmpeg' for compose-motion, 'remotion' for compose-remotion) BEFORE calling pre-compose — the",
  "                        gate's total-duration math is genuinely different per tier (compose-motion sums each cut's own",
  "                        out_seconds-in_seconds as it concatenates cuts in array order; compose-remotion places cuts on",
  "                        one shared absolute timeline and takes max(out_seconds)). Omitting render_runtime silently",
  "                        falls back to the absolute-timeline formula, which under-reports a compose-motion edit's real",
  "                        duration as a single clip's length (confirmed bug, saturn-young-rings 2026-07-12).",
  "                        Pass narrativeDurationSeconds (sum of the script artifact's section durations, or better, the",
  "                        synthesized narration audio's real ffprobe duration) to also run narrative_duration_vs_script:",
  "                        warns/fails when the edit's total composed duration falls far short of what the script/",
  "                        narration actually needs — every cut can pass cut_duration_vs_source individually while the",
  "                        whole edit is still too short to narrate its own story (a flat per-scene clip length like",
  "                        '~8-10s per scene' does NOT automatically match a script whose sections vary 5-22s each;",
  "                        reconcile scene/cut durations against the script's actual per-section lengths, don't just use",
  "                        one constant). Skipped silently when narrativeDurationSeconds is omitted. Also always runs",
  "                        motion_coverage_vs_scene: sums real video-cut seconds vs. total composed seconds and warns/fails",
  "                        when most of the runtime is still-image filler — a still cut with ANY animation (zoom/pan) still",
  "                        counts as filler here even though slideshow_risk above would call it 'has motion'. This is the",
  "                        check that catches padding a scene's remaining duration with a panned freeze-frame instead of",
  "                        chaining more real I2V clips (see generate/video_generation above for the chaining pattern).",
  "                        {verdict, checks[]}.",
  "  • final-review     — {mp4Path, transcriptPath?, narration?} → 6 delivery checks (container, duration>0, video stream,",
  "                        audio stream, volumedetect, midpoint frame) + an advisory transcript check when transcriptPath is",
  "                        given → {verdict:'pass'|'fail', checks[], transcript?}. A fail blocks publish (enforced by",
  "                        write-checkpoint on stages requiring final_review, e.g. publish — see overrideFinalReview above;",
  "                        the transcript check itself stays advisory). Pass narration:'none' (from the script artifact's",
  "                        top-level `narration` field) when the story is intentionally silent/ambient-only, so a genuinely",
  "                        silent track scores audio_level='warn' instead of 'fail'.",
  "  • cost-estimate    — {projectId, tool, operation, estimatedUsd, pipeline?} → entryId. pipeline seeds a brand-new",
  "                        project's budget from orchestration.budget_default_usd (first call only, see `generate`).",
  "  • cost-reserve     — {projectId, entryId} → reserves budget (cap mode raises BudgetExceededError).",
  "  • cost-reconcile   — {projectId, entryId, actualUsd, success} → settles the reservation.",
  "  • cost-snapshot    — {projectId} → {total_spent_usd, total_reserved_usd, budget_remaining_usd}.",
  "  • read-decision-log— {projectId} → {entries[]} append-only (category, subject)-keyed log of provider/model",
  "                        substitutions made mid-session (e.g. tts's edge-tts-over-say opportunistic upgrade — see",
  "                        selector.ts's module doc for the full override-precedence list). Only real substitutions",
  "                        (resolved !== used) are recorded; a call where the pre-resolved and actually-used provider",
  "                        match writes nothing. Complements cost-snapshot: cost tracking only ever sees the FINAL",
  "                        attribution, not the fact a substitution happened or why.",
].join("\n");

/**
 * Slim routing description for the `movie` tool. The heavy per-command reference
 * (option keys, defaults, worked examples) lives in `movie_help` and is fetched
 * on demand — the same dispatcher/help-tool split flux2/ltx/krea2/workflow use.
 * Kept deliberately short: movie is consistently the #1 schema-cost tool, and a
 * routing-only description (vs. the full inline reference) is what clears the
 * ≥30% top-3 schema-cost reduction (verified via `tools-metrics --schema-cost`).
 */
export const ROUTING_DESCRIPTION =
  "Video orchestrator (OpenMontage rewrite). Consumes the native krea2/flux2/ltx " +
  "directors with gate-enforced checkpoints. Call movie_help for the command list + " +
  "per-command options + examples, BEFORE first use.";

/** Slice the COMMAND_REFERENCE block for a single command (its `• <name>` section). */
export function commandReferenceBlock(command: string): string {
  const full = COMMAND_REFERENCE;
  const marker = `  • ${command} `;
  const start = full.indexOf(marker);
  if (start === -1) {
    return `Unknown command "${command}". Known: ${COMMANDS.join(", ")}.`;
  }
  const next = full.indexOf("  • ", start + marker.length);
  return full.slice(start, next === -1 ? undefined : next).trimEnd();
}

export function jsonOut(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

/**
 * Required-string-param guard. The `movie` tool is stateless per call — nothing
 * carries over from a prior init-project/write-checkpoint — so a caller that
 * omits e.g. `pipeline` silently gets `""` today and only finds out from a
 * confusing downstream error (`pipeline "" failed to load`, `unknown schema
 * "artifact/"`). Naming the missing field up front is cheaper for every caller,
 * human or model, than debugging that error.
 */
export function missingFields(opts: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter((f) => opts[f] === undefined || opts[f] === null || String(opts[f]) === "");
}

export type DispatchResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Optional dependency-injection bag for dispatch(). Tests inject a fake
 * spawnImpl here so composeMotion runs its real logic against a stubbed
 * ffmpeg (no host-binary coupling). Production callers omit this entirely.
 */
export interface DispatchDeps {
	/** Forwarded to composeMotion() as its MotionDeps (e.g. { spawnImpl }). */
	composeMotionDeps?: MotionDeps;
}

export async function dispatch(command: Command, opts: Record<string, unknown>, deps?: DispatchDeps): Promise<DispatchResult> {
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
        const missing = missingFields(opts, ["projectId", "pipeline"]);
        if (missing.length > 0) return { ok: false, error: `init-project requires non-empty ${missing.join(", ")}` };
        const projectId = String(opts.projectId ?? "");
        const pipeline = String(opts.pipeline ?? "");
        // Resolve + return the actual projectDir so the caller knows where to
        // place assets (e.g. outputDir for `generate`). The directory itself is
        // materialized on the first write-checkpoint, but the path is stable.
        const order = getStageOrder(pipeline);
        if (order.length === 0) return { ok: false, error: `pipeline "${pipeline}" not loadable` };
        const assetsDir = projectId ? join(projectDir(projectId), "assets") : undefined;
        return {
          ok: true,
          text: jsonOut({
            projectId,
            pipeline,
            stages: order,
            projectDir: projectId ? projectDir(projectId) : "(requires projectId)",
            assetsDir,
            note: "projectDir is created on first write-checkpoint; pass assetsDir as `outputDir` to `generate` so produced files land inside the project workspace.",
          }),
        };
      }
      case "list-projects": {
        // No required options — enumerates MLX_OUTPUT_DIR/movie-director/projects/
        // purely from on-disk checkpoint_*.json files. This is the project-
        // discovery/resumability gap closed per the tool-design audit
        // (2026-07-12): an agent recovering from a crash previously had no way
        // to enumerate what projects/runs it had in flight, since every
        // read-checkpoint-family call requires already knowing the exact
        // projectId. Sorted newest-first by latest checkpoint timestamp.
        return { ok: true, text: jsonOut({ projects: listProjects() }) };
      }
      case "next-stage": {
        const missing = missingFields(opts, ["pipeline"]);
        if (missing.length > 0) return { ok: false, error: `next-stage requires non-empty ${missing.join(", ")}` };
        const pipeline = String(opts.pipeline ?? "");
        const stage = opts.stage ? String(opts.stage) : undefined;
        const stageGateBlock = enforceStageCheckpointGate(pipeline, stage, opts.projectId ? String(opts.projectId) : undefined, {
          overrideStageGate: opts.overrideStageGate === true,
        });
        if (stageGateBlock) return stageGateBlock;
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
        // `status` is intentionally NOT in this list — it defaults to
        // "in_progress" below (writeCheckpoint's documented default for an
        // unfinished stage), so omitting it is a valid call, not an error.
        const missing = missingFields(opts, ["projectId", "pipeline", "stage"]);
        if (missing.length > 0) return { ok: false, error: `write-checkpoint requires non-empty ${missing.join(", ")}` };
        const cp = writeCheckpoint({
          projectId: String(opts.projectId ?? ""),
          pipeline: String(opts.pipeline ?? ""),
          stage: String(opts.stage ?? ""),
          status: String(opts.status ?? "in_progress") as CheckpointStatus,
          artifacts: opts.artifacts as Record<string, unknown> | undefined,
          humanApproved: opts.humanApproved === true,
          overrideFinalReview: opts.overrideFinalReview === true,
          overrideRequiredArtifacts: opts.overrideRequiredArtifacts === true,
          overrideArtifactValidation: opts.overrideArtifactValidation === true,
          review: opts.review,
          costSnapshot: opts.costSnapshot,
          error: opts.error ? String(opts.error) : undefined,
          metadata: opts.metadata as Record<string, unknown> | undefined,
        });
        return { ok: true, text: jsonOut(cp) };
      }
      case "read-checkpoint": {
        const missing = missingFields(opts, ["projectId", "pipeline"]);
        if (missing.length > 0) return { ok: false, error: `read-checkpoint requires non-empty ${missing.join(", ")}` };
        const projectId = String(opts.projectId ?? "");
        const pipeline = String(opts.pipeline ?? "");
        const cp = opts.stage ? readCheckpoint(projectId, String(opts.stage)) : getLatestCheckpoint(projectId, pipeline);
        const completed = getCompletedStages(projectId, pipeline);
        return { ok: true, text: jsonOut({ checkpoint: cp ?? null, completedStages: completed }) };
      }
      case "validate-artifact": {
        const missing = missingFields(opts, ["artifact"]);
        if (opts.data === undefined) missing.push("data");
        if (missing.length > 0) return { ok: false, error: `validate-artifact requires non-empty ${missing.join(", ")}` };
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
        const command = String(opts.command ?? "");
        const pipeline = opts.pipeline ? String(opts.pipeline) : undefined;

        // Pre-resolve the selector so a no-configured-provider error is a clean
        // structured failure (not a thrown stack trace) and so we know the
        // entry before deciding whether to run the cost lifecycle. Pass `command`
        // so {capability, command} addressing routes to the provider that owns
        // the command (e.g. analysis:video_understand → clip, not whisper).
        let entry;
        try {
          entry = selectProvider(capability, { provider, command: command || undefined });
        } catch (err) {
          if (err instanceof NoConfiguredProviderError) {
            return { ok: false, error: err.message };
          }
          throw err;
        }

        // Cost lifecycle (estimate → reserve), run BEFORE generation so a
        // cap-mode/approval breach can block spending instead of proceeding
        // silently (Item 3, output/next-goal-20260712_135012.md — previously
        // BudgetExceededError/ApprovalRequiredError were caught and swallowed
        // into "no cost tracked", invisible to the caller). Only runs when a
        // projectId is given (governance is per-project); any OTHER
        // cost-tracking failure (e.g. a corrupt cost log) stays best-effort.
        let costEntryId: string | undefined;
        if (projectId) {
          const estimated = Number(opts.estimatedUsd ?? 0);
          try {
            costEntryId = costEstimate(projectId, entry.provider, operation, estimated, undefined, pipeline);
            costReserve(projectId, costEntryId);
          } catch (err) {
            if (err instanceof BudgetExceededError || err instanceof ApprovalRequiredError) {
              return { ok: false, error: err.message };
            }
            costEntryId = undefined;
          }
        }

        // `entry` (used for the cost estimate above) is pre-resolved before
        // generation; selectAndGenerate may substitute a different provider at
        // runtime (e.g. tts's edge-tts-first-with-fallback-to-say — see
        // bridge.ts). Report the actually-used entry, not the pre-resolved one,
        // and retag the cost log entry so its `tool` matches what actually ran
        // and was billed (Item 3) rather than the pre-resolved guess.
        const { entry: usedEntry, result } = await selectAndGenerate(
          capability,
          {
            command,
            options: opts.options as Record<string, unknown> | undefined,
            outputDir: opts.outputDir ? String(opts.outputDir) : undefined,
            modelsRoot: opts.modelsRoot ? String(opts.modelsRoot) : undefined,
            extraArgs: opts.extraArgs as string[] | undefined,
          },
          { provider },
        );

        if (projectId && costEntryId) {
          try {
            if (usedEntry.provider !== entry.provider) retagTool(projectId, costEntryId, usedEntry.provider);
            costReconcile(projectId, costEntryId, result.cost_usd, result.success);
          } catch {
            /* best-effort: don't mask the generation result */
          }
        }
        // Decision log: record the substitution itself (independent of cost
        // tracking, which only ever sees the FINAL attribution). No-op when
        // resolved === used (the common case — see recordDecision's doc).
        if (projectId) {
          try {
            recordDecision(projectId, "provider", capability, entry.provider, usedEntry.provider, `generate:${operation}`);
          } catch {
            /* best-effort: don't mask the generation result */
          }
        }

        return {
          ok: true,
          text: jsonOut({ provider: usedEntry.provider, invoke: usedEntry.invoke, costEntryId: costEntryId ?? null, result }),
        };
      }
      case "compose": {
        const edit = opts.editDecisions as EditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "compose requires {editDecisions:{version,cuts:[...]}}" };
        }
        // GATE (tool-design audit, 2026-07-12): this was the one compose tier
        // with NO pre-compose enforcement — compose-remotion/compose-motion
        // both refuse to render on a fail verdict (Bug 2), but an agent using
        // the ffmpeg "foundation" tier got none of the frozen-frame/motion-
        // coverage protections, silently. EditDecisions is a structural subset
        // of RemotionEditDecisions (every field the gate reads — cuts[].id/
        // in_seconds/out_seconds/source — is present on EditCut too), so the
        // same enforcePreCompose runs unmodified.
        const preComposeCheck = await enforcePreCompose(edit as unknown as RemotionEditDecisions, opts);
        if (preComposeCheck) return preComposeCheck;
        const workDir = opts.workDir ? String(opts.workDir) : projectDir(String(opts.projectId ?? "_compose"));
        const captions = opts.captions
          ? { srtPath: String((opts.captions as Record<string, unknown>).srtPath ?? ""), burn: (opts.captions as Record<string, unknown>).burn !== false }
          : undefined;
        const report = await composeVideo(edit, {
          workDir,
          output: opts.output ? String(opts.output) : undefined,
          resolution: opts.resolution ? String(opts.resolution) : undefined,
          fps: opts.fps ? Number(opts.fps) : undefined,
          captions,
        });
        return { ok: true, text: jsonOut(report) };
      }
      case "compose-remotion": {
        const edit = opts.editDecisions as RemotionEditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "compose-remotion requires {editDecisions:{version,cuts:[...]}}" };
        }
        const preComposeCheck = await enforcePreCompose(edit, opts);
        if (preComposeCheck) return preComposeCheck;
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
      case "compose-motion": {
        const edit = opts.editDecisions as RemotionEditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "compose-motion requires {editDecisions:{version,cuts:[...]}}" };
        }
        const preComposeCheck = await enforcePreCompose(edit, opts);
        if (preComposeCheck) return preComposeCheck;
        const workDir = opts.workDir ? String(opts.workDir) : projectDir(String(opts.projectId ?? "_compose_motion"));
        // Forward captions — mirrors the `compose` case. composeMotion()'s
        // captions sub-pass burns/sidecars the SRT via the shared ladder
        // (libass → drawtext → sidecar). Without this, the CLI/agent dropped
        // the param and captions silently vanished (the PR #522 demo
        // workaround used a sidecar SRT outside the composer).
        const captions = opts.captions
          ? { srtPath: String((opts.captions as Record<string, unknown>).srtPath ?? ""), burn: (opts.captions as Record<string, unknown>).burn !== false }
          : undefined;
        const report = await composeMotion(edit, {
          workDir,
          output: opts.output ? String(opts.output) : undefined,
          width: opts.width ? Number(opts.width) : undefined,
          height: opts.height ? Number(opts.height) : undefined,
          fps: opts.fps ? Number(opts.fps) : undefined,
          transitionSeconds: opts.transitionSeconds ? Number(opts.transitionSeconds) : undefined,
          captions,
        }, deps?.composeMotionDeps);
        return { ok: true, text: jsonOut(report) };
      }
      case "pre-compose": {
        const edit = opts.editDecisions as RemotionEditDecisions | undefined;
        if (!edit || !Array.isArray(edit.cuts)) {
          return { ok: false, error: "pre-compose requires {editDecisions:{version,cuts:[...]}}" };
        }
        const narrativeDurationSeconds = opts.narrativeDurationSeconds !== undefined ? Number(opts.narrativeDurationSeconds) : undefined;
        const gate = await preComposeGate(edit, { narrativeDurationSeconds });
        return { ok: true, text: jsonOut(gate) };
      }
      case "final-review": {
        const mp4 = String(opts.mp4Path ?? opts.path ?? "");
        if (!mp4) return { ok: false, error: "final-review requires {mp4Path}" };
        const transcriptPath = opts.transcriptPath ? String(opts.transcriptPath) : undefined;
        const narration = opts.narration === "none" || opts.narration === "voiced" ? opts.narration : undefined;
        const review = await finalReview(mp4, {}, { ...(transcriptPath ? { transcriptPath } : {}), ...(narration ? { narration } : {}) });
        return { ok: true, text: jsonOut(review) };
      }
      case "cost-estimate": {
        const id = costEstimate(
          String(opts.projectId ?? ""),
          String(opts.tool ?? ""),
          String(opts.operation ?? ""),
          Number(opts.estimatedUsd ?? 0),
          undefined,
          opts.pipeline ? String(opts.pipeline) : undefined,
        );
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
      case "read-decision-log": {
        const missing = missingFields(opts, ["projectId"]);
        if (missing.length > 0) return { ok: false, error: `read-decision-log requires non-empty ${missing.join(", ")}` };
        return { ok: true, text: jsonOut(getDecisionLog(String(opts.projectId ?? ""))) };
      }
      default:
        return { ok: false, error: `unknown command: ${command}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
