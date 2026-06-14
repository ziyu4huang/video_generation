import { RUN_PY } from "./paths";
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
        exitCode: -1, outputFiles: [],
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

    const job: Job = {
      id,
      command,
      args: fullArgs,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFiles: [],
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
        env: { ...process.env },
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

    // Drain stdout
    const readStream = async (stream: "stdout" | "stderr", reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const textDecoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = textDecoder.decode(value, { stream: true });
          const lines = text.split("\n");
          for (const line of lines) {
            if (line === "") continue;
            job.logs.push({ text: line, stream });
            this.broadcastLog(id, line, stream);

            // Parse structured output (all command variants: image, video, workflow)
            const savedMatch = /Saved:\s+(.+)/.exec(line);
            if (savedMatch) job.outputFiles.push(savedMatch[1].trim());

            const manifestMatch = /Manifest:\s+(.+)/.exec(line);
            if (manifestMatch) job.manifestPath = manifestMatch[1].trim();

            const runMatch = /Run(?:\s+config)?:\s+(.+)/.exec(line);
            if (runMatch) job.runPath = runMatch[1].trim();

            // Self-test HTML review path marker (printed by I2I self-test)
            const selfTestHtmlMatch = /SelfTestHTML:\s+(.+)/.exec(line);
            if (selfTestHtmlMatch) job.selfTestHtmlPath = selfTestHtmlMatch[1].trim();
          }
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
      job.status = status;
      job.exitCode = exitCode;
      job.completedAt = new Date().toISOString();
      this.broadcastStatus(job);
    };
    this.finalizers.set(id, finalize);

    // Wait for exit, then drain remaining stream output before finalizing status
    proc.exited.then(async (code) => {
      await Promise.all([stdoutDone, stderrDone]);
      finalize(code === 0 ? "completed" : "failed", code);
    }).catch((err) => {
      // Process exited with an error (e.g. signal, spawn-level failure) — surface
      // the reason instead of silently marking failed.
      const msg = `[process exited with error: ${err?.message || err}]`;
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
    try {
      process.kill(job.pid!, "SIGTERM");
      job.logs.push({ text: "[cancelled by user]", stream: "stdout" });
      const finalize = this.finalizers.get(id);
      if (finalize) {
        finalize("failed", -1);
      } else {
        job.status = "failed";
        job.exitCode = -1;
        job.completedAt = new Date().toISOString();
        this.broadcastStatus(job);
      }
      return true;
    } catch {
      return false;
    }
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
