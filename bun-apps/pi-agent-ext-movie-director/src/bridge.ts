/**
 * bridge.ts — the native director bridge + the shared ToolResult contract.
 *
 * Iteration 2's keystone. The registry's `invoke` field names a strategy
 * ("swift:krea2" / "swift:flux2" / "swift:ltx" / ...); this module makes those
 * strategies genuinely callable by delegating to each sibling director's
 * pi-SDK-free `runX()` core (which already resolves the binary, validates
 * paths, spawns, and parses the per-package Details). The three directors have
 * DIFFERENT Details shapes (flux2: rich .manifest.json; krea2: stdout sentinel;
 * ltx: per-command regex) — rather than re-parse stdout here, we reuse their
 * tested parsers and adapt each Details into ONE uniform ToolResult.
 *
 * ToolResult is the contract every director (and, later, every cloud/ffmpeg
 * provider) emits, so the orchestration layer never branches on provider
 * internals: it sees {success, artifacts[], cost_usd, duration_seconds, seed,
 * model} regardless of who generated.
 *
 * Cost: local MLX on Apple Silicon has ~$0 marginal cost (it is your own
 * silicon). cost_usd defaults to 0 (honest) and is overridable via env so
 * budget governance stays exercisable; cloud providers (iteration 3) plug real
 * tariffs into the same field. The estimate→reserve→reconcile lifecycle itself
 * runs in the extension around every generate() call.
 */
import { runKrea2, type Krea2Details, type CommandName as Krea2Command } from "@repo/pi-agent-ext-krea2";
import { runFlux2, type Flux2Details, type CommandName as Flux2Command } from "@repo/pi-agent-ext-flux2";
import {
  runLtx,
  runPyVideo,
  type LtxDetails,
  type CommandName as LtxCommand,
  type RunPyVideoDetails,
  type RunPyVideoOptions,
} from "@repo/pi-agent-ext-ltx";
import type { Capability, ProviderEntry } from "./registry.ts";
import { selectProvider, type SelectorOptions } from "./selector.ts";
import { nonNativeAdapters } from "./providers.ts";
import { runPyCaption, type CaptionDetails, type CaptionOptions } from "./caption.ts";
import {
  runPyImage,
  type RunPyImageDetails,
  type RunPyImageOptions,
} from "./runpy_image.ts";
import {
  runPyStory,
  type RunPyStoryDetails,
  type RunPyStoryOptions,
} from "./runpy_story.ts";

// ─── ToolResult contract ─────────────────────────────────────────────────────

export type ArtifactKind =
  | "image"
  | "video"
  | "audio"
  | "frames"
  | "directory"
  | "data"
  | "text"
  | "unknown";

export interface Artifact {
  /** Absolute filesystem path to the produced artifact (the chaining handle). */
  path: string;
  kind: ArtifactKind;
  seed?: number | null;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  /** For named secondary outputs (e.g. ltx native-i2v audio.wav). */
  role?: string;
}

export interface ToolResult {
  success: boolean;
  /** Which provider actually ran ("krea2" / "flux2" / "ltx" / ...). */
  provider: string;
  /** Director subcommand that ran ("t2i", "native-i2v", ...). */
  command: string;
  artifacts: Artifact[];
  /** Human-readable error when success=false; null on success. */
  error: string | null;
  /** USD spend for this run. 0 for local native (honest); real tariffs for cloud. */
  cost_usd: number;
  /** Wall time in seconds (provider-reported when available, else measured). */
  duration_seconds: number | null;
  /** Generation seed, when known. */
  seed: number | null;
  /** Model identifier, when known (provider name as the fallback). */
  model: string | null;
}

// ─── Tariff ──────────────────────────────────────────────────────────────────

export interface Tariff {
  image_usd: number;
  video_per_sec_usd: number;
}

/** Env-overridable nominal tariff (default 0 = honest for local silicon). */
export function tariffFor(env: Record<string, string | undefined> = process.env): Tariff {
  const num = (v: string | undefined, dflt: number) => {
    const n = Number(v);
    return v != null && Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    image_usd: num(env.MD_TARIFF_IMAGE_USD, 0),
    video_per_sec_usd: num(env.MD_TARIFF_VIDEO_PER_SEC_USD, 0),
  };
}

function costFor(capability: Capability, durationSeconds: number | null, env?: Record<string, string | undefined>): number {
  const t = tariffFor(env);
  if (capability === "video_generation" && durationSeconds != null) {
    return Math.round(t.video_per_sec_usd * durationSeconds * 10000) / 10000;
  }
  if (capability === "image_generation") return t.image_usd;
  return 0;
}

// ─── Generate request ────────────────────────────────────────────────────────

export interface GenerateRequest {
  capability: Capability;
  /** Director subcommand to run (e.g. "t2i", "native-i2v"). */
  command: string;
  /** Per-command options, passed through to the director (camelCase keys). */
  options?: Record<string, unknown>;
  /** Output dir override (resolved+validated by the director). */
  outputDir?: string;
  /** Models root override. */
  modelsRoot?: string;
  /** Escape-hatch raw tokens (validated by the director). */
  extraArgs?: string[];
}

export type InvokeKey = ProviderEntry["invoke"];

/** An adapter runs ONE director and returns its uniform ToolResult. */
export type Adapter = (req: GenerateRequest) => Promise<ToolResult>;

export interface GenerateDeps {
  env?: Record<string, string | undefined>;
  /** Override adapters (tests inject canned results; default = real directors). */
  adapters?: Partial<Record<InvokeKey, Adapter>>;
  /** Inject clock for deterministic duration tests. */
  now?: () => number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function modelFromOptions(provider: string, options?: Record<string, unknown>): string {
  const candidates = ["transformer", "t2iTransformer", "vae", "encoder"];
  for (const k of candidates) {
    const v = options?.[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return provider;
}

function imageKind(_provider: string): ArtifactKind {
  return "image";
}

// ─── Per-package adaptors (Details → ToolResult). Exported for unit testing. ─

export function adaptKrea2(
  req: GenerateRequest,
  details: Krea2Details,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  return {
    success: details.ok,
    provider: "krea2",
    command: details.command,
    artifacts: details.outputs.map((o) => ({
      path: o.path,
      kind: imageKind("krea2"),
      seed: o.seed,
      width: o.width,
      height: o.height,
      bytes: o.sizeBytes,
    })),
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    // krea2 emits no wall time; the generate() wrapper measures it.
    duration_seconds: null,
    seed: details.seed,
    model: modelFromOptions("krea2", req.options),
  };
}

export function adaptFlux2(
  req: GenerateRequest,
  details: Flux2Details,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  return {
    success: details.ok,
    provider: "flux2",
    command: details.command,
    artifacts: details.outputs.map((o) => ({
      path: o.path,
      kind: imageKind("flux2"),
      seed: o.seed,
      width: o.width,
      height: o.height,
      bytes: o.sizeBytes,
    })),
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, details.perf.totalSeconds ?? null, env) : 0,
    duration_seconds: details.perf.totalSeconds,
    seed: details.seed,
    model: modelFromOptions("flux2", req.options),
  };
}

export function adaptLtx(
  req: GenerateRequest,
  details: LtxDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({
      path: details.output,
      kind: details.command.startsWith("native-t2a") ? "audio" : req.capability === "video_generation" ? "video" : "unknown",
      width: details.width,
      height: details.height,
      role: "primary",
    });
  }
  for (const [role, path] of Object.entries(details.extraOutputs)) {
    const kind: ArtifactKind = role.includes("audio")
      ? "audio"
      : role.includes("frame") || role.includes("Frame")
        ? "frames"
        : role.includes("mp4") || role.includes("video")
          ? "video"
          : role.includes("dir")
            ? "directory"
            : "unknown";
    artifacts.push({ path, kind, role });
  }
  return {
    success: details.ok,
    provider: "ltx",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, details.wallSeconds ?? null, env) : 0,
    duration_seconds: details.wallSeconds,
    seed: (req.options?.seed as number | undefined) ?? null,
    model: modelFromOptions("ltx", req.options),
  };
}

// ─── Real adapters (call the directors). The default for generate(). ─────────

async function realKrea2(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runKrea2({
    command: req.command as Krea2Command,
    options: req.options,
    outputDir: req.outputDir,
    modelsRoot: req.modelsRoot,
    extraArgs: req.extraArgs,
  });
  return adaptKrea2(req, out.details, out.summary, out.stderrTail, env);
}

async function realFlux2(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runFlux2({
    command: req.command as Flux2Command,
    options: req.options,
    outputDir: req.outputDir,
    modelsRoot: req.modelsRoot,
    extraArgs: req.extraArgs,
  });
  return adaptFlux2(req, out.details, out.summary, out.stderrTail, env);
}

async function realLtx(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runLtx({
    command: req.command as LtxCommand,
    options: req.options,
    outputDir: req.outputDir,
    modelsRoot: req.modelsRoot,
    extraArgs: req.extraArgs,
  });
  return adaptLtx(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptRunPy — normalize a run.py video t2i2v result into the same ToolResult
 * shape the swift directors emit. The single artifact is the produced .mp4
 * (kind:"video"); ok = run.py exited 0 AND the mp4 landed on disk (a 0-exit
 * review/empty run is NOT a generation success). The model id comes from the
 * manifest's i2v stage transformer (local silicon — never cloud).
 */
export function adaptRunPy(
  req: GenerateRequest,
  details: RunPyVideoDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.output) {
    artifacts.push({ path: details.output, kind: "video", role: "primary" });
  }
  return {
    success: details.ok,
    provider: "ltx-runpy",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: (req.options?.seed as number | undefined) ?? null,
    // Prefer the manifest's i2v transformer (local) when present; fall back to a
    // local label so the result never reads as a cloud model id.
    model: details.model ?? "run.py:t2i2v",
  };
}

async function realRunPy(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyVideo({
    options: (req.options ?? {}) as RunPyVideoOptions,
    outputDir: req.outputDir,
    extraArgs: req.extraArgs,
  });
  return adaptRunPy(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptCaption — normalize a run.py caption result into a ToolResult. The single
 * artifact is the produced <image>.caption.json (kind:"text" — an analysis text
 * output, the chaining handle for OM's review/retrieval tiers); ok = run.py
 * exited 0 AND the caption JSON landed + parsed. The model id is the resolved
 * local VLM recorded in the JSON (the gemma brain — never a cloud id).
 */
export function adaptCaption(
  req: GenerateRequest,
  details: CaptionDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  if (details.captionPath) {
    artifacts.push({ path: details.captionPath, kind: "text", role: "caption" });
  }
  return {
    success: details.ok,
    provider: "caption-vlm",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    // Analysis is local silicon: nominal $0 (honest), env-overridable like image.
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    // Prefer the JSON's recorded model (the resolved gemma brain); fall back to a
    // local label so the result never reads as a cloud model id.
    model: details.model ?? "run.py:caption",
  };
}

async function realCaption(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyCaption({ options: (req.options ?? {}) as CaptionOptions });
  return adaptCaption(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptRunPyImage — normalize a run.py image result into the same ToolResult
 * shape the swift directors emit. Each produced image (manifest output_files[],
 * or the globbed newest-image fallback) becomes one kind:"image" artifact carrying
 * its seed/width/height/bytes when the manifest recorded them. ok = run.py exited
 * 0 AND a real image landed on disk (a 0-exit review/list-only run is NOT a
 * generation success — mirrors adaptRunPy). The model id is the manifest's local
 * transformer basename (zimage / flux2-klein / lens — never a cloud id).
 */
export function adaptRunPyImage(
  req: GenerateRequest,
  details: RunPyImageDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = details.outputs.map((o) => ({
    path: o.path,
    kind: "image",
    seed: o.seed ?? null,
    width: o.width ?? null,
    height: o.height ?? null,
    bytes: o.sizeBytes ?? null,
    role: "primary",
  }));
  return {
    success: details.ok,
    provider: "runpy-image",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: details.elapsedSeconds,
    seed: (req.options?.seed as number | undefined) ?? details.outputs[0]?.seed ?? null,
    // Prefer the manifest's local transformer basename; fall back to a local label
    // so the result never reads as a cloud model id.
    model: details.model ?? `run.py:${details.command}`,
  };
}

async function realRunPyImage(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyImage({
    options: (req.options ?? {}) as RunPyImageOptions,
    outputDir: req.outputDir,
    extraArgs: req.extraArgs,
  });
  return adaptRunPyImage(req, out.details, out.summary, out.stderrTail, env);
}

/**
 * adaptRunPyStory — normalize a run.py story result. angles/propose produce a
 * structured text artifact (the angles.json / proposal.yaml the agent reads for
 * the approval gate, kind:"text"); shots produces storyboard image frames
 * (kind:"image", delegated to `image storyboard`). ok = run.py exited 0 AND the
 * sub-action's expected artifact parsed (angles/concepts) or ≥1 frame landed
 * (shots). LOCAL MLX + local gemma brain — never a cloud id.
 */
export function adaptRunPyStory(
  req: GenerateRequest,
  details: RunPyStoryDetails,
  summary: string,
  stderrTailStr: string,
  env?: Record<string, string | undefined>,
): ToolResult {
  const artifacts: Artifact[] = [];
  // angles/propose: the structured artifact is the deliverable.
  if (details.artifactPath) {
    artifacts.push({ path: details.artifactPath, kind: "text", role: "primary" });
  }
  // shots: the delegated storyboard frames.
  for (const p of details.outputs) {
    artifacts.push({ path: p, kind: "image", role: "primary" });
  }
  return {
    success: details.ok,
    provider: "runpy-story",
    command: details.command,
    artifacts,
    error: details.ok ? null : `${summary}\n${stderrTailStr}`.trim(),
    cost_usd: details.ok ? costFor(req.capability, null, env) : 0,
    duration_seconds: null,
    seed: null,
    model: "run.py:story",
  };
}

async function realRunPyStory(req: GenerateRequest, env?: Record<string, string | undefined>): Promise<ToolResult> {
  const out = await runPyStory({
    options: (req.options ?? {}) as RunPyStoryOptions,
    outputDir: req.outputDir,
    extraArgs: req.extraArgs,
  });
  return adaptRunPyStory(req, out.details, out.summary, out.stderrTail, env);
}

/** The live adapter map. Tests override entries via GenerateDeps.adapters. */
export function realAdapters(env?: Record<string, string | undefined>): Partial<Record<InvokeKey, Adapter>> {
  return {
    "swift:krea2": (req) => realKrea2(req, env),
    "swift:flux2": (req) => realFlux2(req, env),
    "swift:ltx": (req) => realLtx(req, env),
    "mlx:runpy": (req) => realRunPy(req, env),
    "mlx:runpy-image": (req) => realRunPyImage(req, env),
    "mlx:runpy-story": (req) => realRunPyStory(req, env),
    "mlx:caption": (req) => realCaption(req, env),
    // Non-native adapters (ffmpeg / pure-Bun subtitle / cloud HTTP) — iteration 3.
    ...nonNativeAdapters(env),
  };
}

// ─── generate(): select → adapt → measure ────────────────────────────────────

export interface GenerateOutcome {
  /** The provider entry that ran (selected by the selector). */
  entry: ProviderEntry;
  result: ToolResult;
}

/**
 * Run a generation end-to-end: the selector picks the provider (or the caller
 * pre-selects), the bridge runs the director via its adapter, and the result is
 * normalized to ToolResult. Cost reconciliation against the budget tracker is
 * the caller's responsibility (the extension wires estimate→reserve→reconcile
 * around this call) — generate() itself is pure of fs/cost IO.
 */
export async function generate(
  entry: ProviderEntry,
  req: GenerateRequest,
  deps: GenerateDeps = {},
): Promise<ToolResult> {
  const env = deps.env;
  const adapters = deps.adapters ?? realAdapters(env);
  const adapter = adapters[entry.invoke];
  const now = deps.now ?? Date.now;
  const start = now();

  if (!adapter) {
    return {
      success: false,
      provider: entry.provider,
      command: req.command,
      artifacts: [],
      error: `no bridge implemented for invoke "${entry.invoke}" (provider "${entry.name}")`,
      cost_usd: 0,
      duration_seconds: (now() - start) / 1000,
      seed: null,
      model: entry.provider,
    };
  }

  let result: ToolResult;
  try {
    result = await adapter(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      success: false,
      provider: entry.provider,
      command: req.command,
      artifacts: [],
      error: msg,
      cost_usd: 0,
      duration_seconds: (now() - start) / 1000,
      seed: null,
      model: entry.provider,
    };
  }

  // Fill duration from wall time when the director didn't report it (krea2).
  if (result.duration_seconds == null) {
    result = { ...result, duration_seconds: (now() - start) / 1000 };
  }
  return result;
}

/**
 * Convenience: select the provider for a capability then generate. Returns the
 * selected entry alongside the result so the caller can record which provider ran.
 */
export async function selectAndGenerate(
  capability: Capability,
  req: Omit<GenerateRequest, "capability">,
  selectorOpts: SelectorOptions = {},
  deps: GenerateDeps = {},
): Promise<GenerateOutcome> {
  // Default the selector's command to the request's command so a caller that
  // addresses {capability, command} routes correctly without re-passing command
  // in selectorOpts (command-routing tiebreak lives in the selector).
  const entry = selectProvider(capability, { ...selectorOpts, command: selectorOpts.command ?? req.command });
  const result = await generate(entry, { ...req, capability }, deps);
  return { entry, result };
}
