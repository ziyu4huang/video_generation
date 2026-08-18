import path from "path";
import { RUN_PY, OUTPUT_DIRS, MLX_OUTPUT_DIR, REPO_DIR } from "./paths";
import { resolvePythonBin } from "./pythonBin";
import { saveJobs, loadJobs } from "./jobstore";

export interface LogLine {
  text: string;
  stream: "stdout" | "stderr";
}

export interface Job {
  id: string;
  command: string;
  args: string[];
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  pid?: number;
  outputFiles: string[];
  outputUrls: string[];
  manifestPath?: string;
  runPath?: string;
  selfTestHtmlPath?: string;
  logs: LogLine[];
  action?: string;
  params?: Record<string, any>;
}

type LogListener = (jobId: string, line: string, stream: "stdout" | "stderr") => void;
type StatusListener = (job: Job) => void;

export class SubprocessManager {
  private jobs = new Map<string, Job>();
  private finalizers = new Map<string, (status: "completed" | "failed", exitCode: number) => void>();
  private logListeners = new Set<LogListener>();
  private statusListeners = new Set<StatusListener>();

  onLog(fn: LogListener) { this.logListeners.add(fn); return () => this.logListeners.delete(fn); }
  onStatus(fn: StatusListener) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }

  private broadcastLog(jobId: string, line: string, stream: "stdout" | "stderr") {
    for (const fn of this.logListeners) fn(jobId, line, stream);
  }

  private broadcastStatus(job: Job) {
    for (const fn of this.statusListeners) fn(job);
    this.persistJobs();
  }

  private persistJobs() {
    saveJobs(Array.from(this.jobs.values()));
  }

  loadAndRestoreJobs(): void {
    const saved = loadJobs();
    const now = new Date().toISOString();
    for (const job of saved) {
      if (job.status === "running") {
        job.status = "failed";
        job.completedAt = now;
        job.logs.push({ text: "[interrupted: server restarted]", stream: "stdout" });
      }
      this.jobs.set(job.id, job);
    }
    this.persistJobs();
  }

  spawn(command: string, cliArgs: string[], meta?: { action?: string; params?: Record<string, any> }): string {
    const id = Bun.randomUUIDv7();
    // Defense-in-depth against argv injection: command is a space-joined run.py
    // invocation ("image t2i" | "video relay" | "check-model"). Reject any token
    // that isn't a bare identifier so a stray space/shell metachar can't inject
    // argv. Callers (jobs.ts/selftest.ts/model-check.ts) pass trusted server-
    // derived commands; this guarantees that contract at the spawn boundary.
    const parts = command.split(" ").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
      const job: Job = {
        id, command, args: [], status: "failed",
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        exitCode: -1, outputFiles: [], outputUrls: [],
        logs: [{ text: `[rejected: invalid command '${command}']`, stream: "stderr" }],
        action: meta?.action, params: meta?.params,
      };
      this.jobs.set(id, job);
      this.persistJobs();
      this.broadcastLog(id, job.logs[0]!.text, "stderr");
      this.broadcastStatus(job);
      return id;
    }
    const fullArgs = [RUN_PY, ...parts, ...cliArgs];
  // Explicit > implicit: always pass the resolved output dir to run.py via CLI
  // arg so the generator writes where the GUI watches (no env-inheritance drift,
  // and the job's recorded args are self-describing). --gen-output-dir is a run.py
  // global flag (_global_parser), accepted by every subcommand.
  if (MLX_OUTPUT_DIR) fullArgs.push("--gen-output-dir", MLX_OUTPUT_DIR);

    const job: Job = {
      id,
      command,
      args: fullArgs,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFiles: [],
      outputUrls: [],
      logs: [],
      action: meta?.action,
      params: meta?.params,
    };

    this.jobs.set(id, job);
    this.persistJobs();

    const pythonBin = resolvePythonBin();
    // Wrap spawn so a synchronous failure (e.g. ENOENT on a missing pythonBin)
    // surfaces to the job log + status instead of crashing the request handler.
    let proc: any;
    try {
      proc = Bun.spawn([pythonBin, ...fullArgs], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: REPO_DIR, // run.py resolves models/output PWD-relative → always from repo root
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
    } catch (err: any) {
      const msg = `[spawn failed: ${err?.message || err}]`;
      job.logs.push({ text: msg, stream: "stderr" });
      this.broadcastLog(id, msg, "stderr");
      job.status = "failed";
      job.exitCode = -1;
      job.completedAt = new Date().toISOString();
      this.broadcastStatus(job);
      return id;
    }

    job.pid = proc.pid;

    // Broadcast the "running" status now so WS clients (e.g. the useJobs hook)
    // can revalidate their job list the instant a job starts. Previously only
    // completed/failed transitions were broadcast (the finalize paths below),
    // so the frontend's job_start listener was dead code and the job list lagged
    // up to refreshInterval (5s) before showing a running job.
    this.broadcastStatus(job);

    // Guard: Bun.spawn can return a proc whose stdout/stderr are null (e.g. a
    // spawn-level pipe failure the try/catch above didn't surface). The
    // getReader() calls below would throw synchronously OUTSIDE that try/catch,
    // crashing the request handler and leaving the job stuck in 'running'
    // (finalize never runs). Finalize as failed instead, mirroring the spawn-
    // failed catch path.
    if (!proc.stdout || !proc.stderr) {
      const msg = "[spawn failed: proc has no stdout/stderr stream]";
      job.logs.push({ text: msg, stream: "stderr" });
      this.broadcastLog(id, msg, "stderr");
      job.status = "failed";
      job.exitCode = -1;
      job.completedAt = new Date().toISOString();
      this.broadcastStatus(job);
      return id;
    }

    // Drain stdout
    const readStream = async (stream: "stdout" | "stderr", reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const textDecoder = new TextDecoder();
      // Buffer partial lines across read() chunks: a chunk boundary can split a
      // line (e.g. "Sa" | "ved: x.png"). Previously each fragment was emitted as
      // its own log entry AND the Saved:/Manifest:/Run:/SelfTestHTML regexes that
      // track output files were matched against the fragments, missing real
      // matches. Hold the trailing segment (after the last newline) until the
      // next chunk completes it; flush any leftover when the stream ends.
      let pending = "";
      const processLine = (line: string) => {
        if (line === "") return;
        job.logs.push({ text: line, stream });
        this.broadcastLog(id, line, stream);

        // Parse structured output (all command variants: image, video, workflow)
        const savedMatch = /Saved:\s+(.+)/.exec(line);
        if (savedMatch) {
          const absPath = savedMatch[1].trim();
          job.outputFiles.push(absPath);
          const basename = path.basename(absPath);
          const di = OUTPUT_DIRS.findIndex((d) => absPath.startsWith(d + path.sep));
          job.outputUrls.push(di >= 0 ? `/output/${di}/${basename}` : `/output/${basename}`);
        }

        const manifestMatch = /Manifest:\s+(.+)/.exec(line);
        if (manifestMatch) job.manifestPath = manifestMatch[1].trim();

        const runMatch = /Run(?:\s+config)?:\s+(.+)/.exec(line);
        if (runMatch) job.runPath = runMatch[1].trim();

        // Self-test HTML review path marker (printed by I2I self-test)
        const selfTestHtmlMatch = /SelfTestHTML:\s+(.+)/.exec(line);
        if (selfTestHtmlMatch) job.selfTestHtmlPath = selfTestHtmlMatch[1].trim();
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += textDecoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          // The final segment (after the last newline) may be a partial line —
          // keep it buffered for the next chunk to complete.
          pending = lines.pop() ?? "";
          for (const line of lines) processLine(line);
        }
        // Flush a trailing line that had no final newline before EOF.
        if (pending !== "") {
          processLine(pending);
          pending = "";
        }
      } catch {
        // Stream closed
      }
    };

    const stdoutDone = readStream("stdout", proc.stdout.getReader());
    const stderrDone = readStream("stderr", proc.stderr.getReader());

    // Guard against double-finalization (killJob vs proc.exited race)
    let finalized = false;
    const finalize = (status: "completed" | "failed", exitCode: number) => {
      if (finalized) return;
      finalized = true;
      this.finalizers.delete(id);
      // If the job was removed from the map (e.g. via deleteJob) between exit
      // and this late finalize, don't re-broadcast status or re-persist an
      // orphan job object.
      if (!this.jobs.has(id)) return;
      job.status = status;
      job.exitCode = exitCode;
      job.completedAt = new Date().toISOString();
      this.broadcastStatus(job);
    };
    this.finalizers.set(id, finalize);

    // Wait for exit, then drain remaining stream output before finalizing status
    proc.exited.then(async (code: number) => {
      await Promise.all([stdoutDone, stderrDone]);
      finalize(code === 0 ? "completed" : "failed", code);
    }).catch((err: unknown) => {
      // Process exited with an error (e.g. signal, spawn-level failure) — surface
      // the reason instead of silently marking failed.
      const detail = err instanceof Error ? err.message : String(err);
      const msg = `[process exited with error: ${detail}]`;
      job.logs.push({ text: msg, stream: "stderr" });
      this.broadcastLog(id, msg, "stderr");
      finalize("failed", -1);
    });

    return id;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listJobs(): Job[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  killJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    if (job.pid === undefined) return false;
    // Capture the narrowed pid. The SIGKILL fallback below fires 5s later and
    // would otherwise re-read `job.pid` at that point — a widening TypeScript
    // was right to flag, since the read happens long after this guard.
    const pid = job.pid;
    try {
      process.kill(pid, "SIGTERM");
      job.logs.push({ text: "[cancelled by user]", stream: "stdout" });
      // Do NOT finalize synchronously. The proc.exited → drain → finalize path
      // above will finalize as 'failed' once the process exits and its
      // stdout/stderr finish draining, so trailing log lines get persisted too.
      // Finalizing here would trip the `finalized` guard and turn that drain
      // path into a no-op, dropping late output from the persisted jobs.json.
      // Fallback: if the child ignores SIGTERM and is still running after 5s,
      // ESCALATE to SIGKILL instead of finalizing directly. A direct finalize
      // here would race the still-draining stdout/stderr streams — it persists
      // status before trailing output lands (broadcastLog doesn't trigger a
      // persist), dropping the tail. SIGKILL forces the process to exit, so the
      // normal proc.exited → drain → finalize path runs end-to-end and the
      // drain-before-finalize invariant holds. (Finalized-guard above makes a
      // later SIGKILL-triggered finalize the only one that sticks.)
      setTimeout(() => {
        const j = this.jobs.get(id);
        if (!j || j.status !== "running") return;
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }, 5000);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Remove a job from history (used for finished jobs the user dismisses).
   * Defensive: if the job is somehow still running, terminate its child first
   * so we don't orphan a process; the finalize guard above makes any late
   * proc.exited callback a no-op once the job is gone from the map.
   */
  deleteJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "running" && job.pid) {
      try { process.kill(job.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    this.finalizers.delete(id);
    this.jobs.delete(id);
    this.persistJobs();
    return true;
  }
  clearJobs(statuses: Job["status"][]): number {
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (statuses.includes(job.status)) {
        this.jobs.delete(id);
        count++;
      }
    }
    this.persistJobs();
    return count;
  }
}

// Singleton
export const subprocessManager = new SubprocessManager();

// On graceful server shutdown (Ctrl-C / kill), terminate running run.py children
// so they don't orphan and keep consuming GPU/CPU after the server is gone.
// (loadAndRestoreJobs already marks them "failed" on next startup; this prevents
// the orphan from running at all.)
function killRunningChildren(): void {
  for (const job of subprocessManager.listJobs()) {
    if (job.status === "running" && job.pid) {
      try { process.kill(job.pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }
}
process.once("SIGINT", () => { killRunningChildren(); process.exit(0); });
process.once("SIGTERM", () => { killRunningChildren(); process.exit(0); });
