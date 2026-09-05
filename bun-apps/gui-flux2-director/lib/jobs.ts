/**
 * jobs.ts — generation/upscale job registry: spawn flux2, stream its output
 * into a per-job log, parse stage + result path, broadcast to SSE subscribers,
 * abort cleanly.
 *
 * The CLI does not emit per-step progress (the denoise loop is silent), so the
 * stage model is: queued → loading (models) → generating (diffusion) → done.
 * The `✅ generated/upscaled <name>` + absolute-path echo pair identifies the
 * output PNG for the UI.
 */
import path from "path";
import { invokeFlux2 } from "@repo/s2-agent-ext-flux2/src/invoke.ts";

import { FLUX2_BIN, OUTPUT_DIR, REPO_DIR, flux2BinExists, flux2MetallibExists } from "./paths";

export type JobKind = "t2i" | "upscale" | "story";
export type JobStage =
  | "queued"
  | "loading"
  | "generating"
  | "writing"
  | "keyframes"
  | "grid"
  | "voice"
  | "rendering"
  | "mixing"
  | "done";
export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  /** CLI args after the subcommand (for display + re-run). */
  args: string[];
  status: JobStatus;
  stage: JobStage;
  prompt?: string;
  createdAt: number;
  finishedAt?: number;
  exitCode?: number;
  /** Absolute PNG path parsed from the ✅ output echo. */
  outputPath?: string;
  error?: string;
  log: string[];
}

export interface JobSummary extends Omit<Job, "log"> {
  logLines: number;
}

export type JobEvent =
  | { type: "state"; job: JobSummary }
  | { type: "log"; id: string; text: string }
  | { type: "stage"; id: string; stage: JobStage };

export type Subscriber = (evt: JobEvent) => void;

/** Identifier line → stage transition. Order matters: generating wins later. */
export function stageForLine(line: string, current: JobStage): JobStage | null {
  if (line.includes("loading models")) return "loading";
  if (line.includes("generating") || line.includes("upscale —")) return "generating";
  if (line.startsWith("✅")) return "done";
  return null;
}

/** The CLI echoes the output PNG as an indented absolute path after ✅. */
export function outputPathForLine(line: string): string | null {
  const t = line.trim();
  if (t.startsWith("/") && t.endsWith(".png")) return t;
  return null;
}

const MAX_LOG_LINES = 800;
const MAX_FINISHED_JOBS = 40;

/** Handle a pipeline runner uses to drive its job (story: keyframes→grid→render). */
export interface PipelineHandle {
  log(line: string): void;
  stage(stage: JobStage): void;
  setOutput(path: string): void;
  signal: AbortSignal;
}

class JobManager {
  private jobs = new Map<string, Job>();
  private subscribers = new Set<Subscriber>();
  private controllers = new Map<string, AbortController>();
  private seq = 0;

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  list(limit = 30): JobSummary[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((j) => this.summarize(j));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** True when a generation/upscale is still in flight (single-GPU guard). */
  hasRunning(): boolean {
    for (const j of this.jobs.values()) {
      if (j.status === "running") return true;
    }
    return false;
  }

  private broadcast(evt: JobEvent): void {
    for (const s of this.subscribers) {
      try {
        s(evt);
      } catch {
        /* a dead SSE writer must not break the pump */
      }
    }
  }

  private summarize(j: Job): JobSummary {
    const { log, ...rest } = j;
    return { ...rest, logLines: log.length };
  }

  private appendLog(j: Job, line: string): void {
    j.log.push(line);
    if (j.log.length > MAX_LOG_LINES) j.log.splice(0, j.log.length - MAX_LOG_LINES);
    this.broadcast({ type: "log", id: j.id, text: line });
    // Pipeline jobs (story) drive stages explicitly via handle.stage(); only
    // single-process jobs derive the stage from CLI banner lines.
    if (j.kind !== "story") {
      const stage = stageForLine(line, j.stage);
      if (stage && stage !== j.stage) {
        j.stage = stage;
        this.broadcast({ type: "stage", id: j.id, stage });
      }
    }
    const out = outputPathForLine(line);
    if (out) {
      j.outputPath = out;
      this.broadcast({ type: "state", job: this.summarize(j) });
    }
  }

  /**
   * Spawn a single-process flux2 job. Does NOT enforce single-flight — the
   * caller decides (the API rejects concurrent jobs; tests spawn freely).
   */
  start(kind: JobKind, args: string[], opts: { prompt?: string } = {}): Job {
    if (!flux2BinExists()) {
      throw new Error(
        `flux2 binary not found at ${FLUX2_BIN} — build it: ` +
          `swift build -c release --package-path swift/flux2-image-director`,
      );
    }
    if (!flux2MetallibExists()) {
      throw new Error(
        `mlx.metallib missing next to ${FLUX2_BIN} — every MLX compute call would ` +
          `die. Run: bash swift/flux2-image-director/scripts/build-metallib.sh`,
      );
    }
    return this.register(kind, args, opts, (job, handle) => {
      invokeFlux2({
        bin: FLUX2_BIN,
        args,
        cwd: REPO_DIR,
        signal: handle.signal,
        onProgress: ({ text }) => handle.log(text),
      }).then((result) => {
        if (result.aborted) {
          job.status = "cancelled";
        } else if (result.exitCode === 0) {
          job.status = "done";
        } else {
          job.status = "failed";
          const tail = job.log.slice(-6).join(" | ");
          job.error = `exit ${result.exitCode}${tail ? `: ${tail}` : ""}`;
        }
        job.exitCode = result.exitCode;
        this.settle(job);
      });
    });
  }

  /**
   * Run a multi-step pipeline (story: flux2 keyframes → grid → ltx render) as
   * ONE job. The runner drives stages/log/output through the handle; a throw
   * fails the job with the error as its message.
   */
  startPipeline(
    kind: JobKind,
    args: string[],
    opts: { prompt?: string },
    runner: (job: Job, handle: PipelineHandle) => Promise<unknown>,
  ): Job {
    return this.register(kind, args, opts, (job, handle) => {
      runner(job, handle)
        .then(() => {
          if (job.status === "running") job.status = "done";
        })
        .catch((err) => {
          if (job.status === "running") {
            job.status = "failed";
            job.error = String((err as Error)?.message ?? err);
          }
        })
        .then(() => {
          job.exitCode = job.status === "done" ? 0 : 1;
          this.settle(job);
        });
    });
  }

  /** Common job bookkeeping: create, broadcast, hand to the runner. */
  private register(
    kind: JobKind,
    args: string[],
    opts: { prompt?: string },
    run: (job: Job, handle: PipelineHandle) => void,
  ): Job {
    this.seq += 1;
    const id = `${Date.now().toString(36)}-${this.seq}`;
    const job: Job = {
      id,
      kind,
      args,
      status: "running",
      stage: "queued",
      prompt: opts.prompt,
      createdAt: Date.now(),
      log: [],
    };
    this.jobs.set(id, job);
    this.broadcast({ type: "state", job: this.summarize(job) });

    // One abort controller per job — cancel(id) aborts it; pipelines pass
    // handle.signal into every spawned child so a cancel kills the current step.
    const ac = new AbortController();
    this.controllers.set(id, ac);

    const handle: PipelineHandle = {
      log: (line) => this.appendLog(job, line),
      stage: (stage) => {
        if (stage !== job.stage) {
          job.stage = stage;
          this.broadcast({ type: "stage", id: job.id, stage });
        }
      },
      setOutput: (path) => {
        job.outputPath = path;
        this.broadcast({ type: "state", job: this.summarize(job) });
      },
      signal: ac.signal,
    };

    run(job, handle);
    return job;
  }

  private settle(job: Job): void {
    job.stage = job.status === "done" ? "done" : job.stage;
    job.finishedAt = Date.now();
    this.controllers.delete(job.id);
    this.broadcast({ type: "state", job: this.summarize(job) });
    this.prune();
  }

  cancel(id: string): boolean {
    const ac = this.controllers.get(id);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((j) => j.status !== "running")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const j of finished.slice(MAX_FINISHED_JOBS)) this.jobs.delete(j.id);
  }
}

/** Process-wide registry (module singleton; survives --hot via globalThis). */
const globalScope = globalThis as typeof globalThis & {
  __flux2GuiJobs?: JobManager;
};
export const jobManager: JobManager = (globalScope.__flux2GuiJobs ??= new JobManager());

/** Build `--output` for an upscale that sits NEXT TO its input (gallery-visible). */
export function upscaleOutputPath(input: string): string {
  const dir = path.dirname(input);
  const ext = path.extname(input);
  const base = path.basename(input, ext);
  return path.join(dir, `${base}.4x${ext || ".png"}`);
}

/** Where generations land when the client doesn't pick a name. */
export function defaultOutputDir(): string {
  return OUTPUT_DIR;
}
