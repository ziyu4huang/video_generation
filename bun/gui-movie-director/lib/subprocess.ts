import { randomUUID } from "crypto";
import { PYTHON_BIN, RUN_PY } from "./paths";

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
  }

  spawn(action: string, cliArgs: string[]): string {
    const id = randomUUID();
    const fullArgs = [RUN_PY, "image", action, ...cliArgs];

    const job: Job = {
      id,
      command: `image ${action}`,
      args: fullArgs,
      status: "running",
      startedAt: new Date().toISOString(),
      outputFiles: [],
      logs: [],
    };

    this.jobs.set(id, job);

    const proc = Bun.spawn([PYTHON_BIN, ...fullArgs], {
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

            // Parse structured output
            if (line.startsWith("Saved:")) {
              const path = line.slice(6).trim();
              job.outputFiles.push(path);
            }
            if (line.startsWith("Manifest:") || line.includes("Manifest:")) {
              const match = line.match(/Manifest:\s*(\S+)/);
              if (match) job.manifestPath = match[1];
            }
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
