import { randomUUID } from "crypto";
import { RUN_PY } from "./paths";
import { loadConfig } from "./config";
import { saveJobs, loadJobs } from "./jobstore";

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
  logs: string[];
}

type LogListener = (jobId: string, line: string, stream: "stdout" | "stderr") => void;
type StatusListener = (job: Job) => void;

export class SubprocessManager {
  private jobs = new Map<string, Job>();
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
        job.logs.push("[interrupted: server restarted]");
      }
      this.jobs.set(job.id, job);
    }
    this.persistJobs();
  }

  spawn(command: string, cliArgs: string[]): string {
    const id = randomUUID();
    const parts = command.split(" ");
    const fullArgs = [RUN_PY, ...parts, ...cliArgs];

    const job: Job = {
      id,
      command,
      args: fullArgs,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFiles: [],
      logs: [],
    };

    this.jobs.set(id, job);
    this.persistJobs();

    const proc = Bun.spawn([loadConfig().pythonPath, ...fullArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    job.pid = proc.pid;

    // Drain stdout
    const readStream = async (stream: "stdout" | "stderr", reader: any) => {
      const textDecoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = textDecoder.decode(value, { stream: true });
          const lines = text.split("\n");
          for (const line of lines) {
            if (line === "") continue;
            job.logs.push(line);
            this.broadcastLog(id, line, stream);

            // Parse structured output (all command variants: image, video, workflow)
            const savedMatch = /Saved:\s+(.+)/.exec(line);
            if (savedMatch) job.outputFiles.push(savedMatch[1].trim());

            const manifestMatch = /Manifest:\s+(.+)/.exec(line);
            if (manifestMatch) job.manifestPath = manifestMatch[1].trim();

            const runMatch = /Run(?:\s+config)?:\s+(.+)/.exec(line);
            if (runMatch) job.runPath = runMatch[1].trim();
          }
        }
      } catch {
        // Stream closed
      }
    };

    readStream("stdout", proc.stdout.getReader());
    readStream("stderr", proc.stderr.getReader());

    // Wait for exit
    proc.exited.then((code) => {
      job.status = code === 0 ? "completed" : "failed";
      job.exitCode = code;
      job.completedAt = new Date().toISOString();
      this.broadcastStatus(job);
    }).catch(() => {
      job.status = "failed";
      job.exitCode = -1;
      job.completedAt = new Date().toISOString();
      this.broadcastStatus(job);
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
      job.status = "failed";
      job.exitCode = -1;
      job.completedAt = new Date().toISOString();
      job.logs.push("[cancelled by user]");
      this.broadcastStatus(job);
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton
export const subprocessManager = new SubprocessManager();
