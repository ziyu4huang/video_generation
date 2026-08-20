/**
 * invoke.ts — spawn `flux2`, stream progress, honor abort.
 *
 * Line-buffered stdout+stderr → onUpdate({kind:"progress"}). On AbortSignal we
 * SIGTERM (then SIGKILL after a grace window) the child and its tree so a long
 * generation can be cancelled cleanly. Returns the full merged output + exit.
 */
import { spawn } from "node:child_process";

export interface ProgressFn {
  (update: { kind: "progress"; text: string }): void;
}

export interface InvokeResult {
  exitCode: number;
  /** Combined stdout + stderr text (in arrival order). */
  output: string;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

/** Kill a process tree: SIGTERM, escalate to SIGKILL after `graceMs`. */
function killTree(pid: number, graceMs = 1500): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }, graceMs).unref();
}

export interface InvokeOpts {
  bin: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  onProgress?: ProgressFn;
  /** Extra env merged onto process.env. */
  env?: Record<string, string>;
}

/** Spawn flux2 and stream until exit/abort. Never rejects — check exitCode/aborted. */
export function invokeFlux2(opts: InvokeOpts): Promise<InvokeResult> {
  return new Promise((resolveP) => {
    const proc = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    let stdout = "";
    let stderr = "";
    let merged = "";
    let aborted = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolveP({ exitCode, output: merged, stdout, stderr, aborted });
    };

    const lineBuf = { out: "", err: "" };
    const handle = (stream: NodeJS.ReadableStream, key: "out" | "err", sink: (s: string) => void) => {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        sink(text);
        merged += text;
        lineBuf[key] += text;
        let nl: number;
        while ((nl = lineBuf[key].indexOf("\n")) >= 0) {
          const line = lineBuf[key].slice(0, nl).trim();
          lineBuf[key] = lineBuf[key].slice(nl + 1);
          if (line) {
            // onProgress runs out-of-band inside this stream 'data' handler,
            // outside any caller's try/catch around `await invokeFlux2(...)` —
            // a throw here would otherwise surface as an uncaught exception
            // instead of respecting this function's own "Never rejects"
            // contract (same fix as s2-agent-ext-ltx's invoke.ts, backported
            // from s2-agent-ext-ltx-self-improve's review lane, 2026-07-05).
            try {
              opts.onProgress?.({ kind: "progress", text: line });
            } catch {
              /* progress callback failures must not crash the subprocess pump */
            }
          }
        }
      });
    };
    handle(proc.stdout!, "out", (s) => (stdout += s));
    handle(proc.stderr!, "err", (s) => (stderr += s));

    proc.on("error", (err) => {
      merged += `\n[spawn error] ${err.message}\n`;
      stderr += `\n[spawn error] ${err.message}\n`;
      finish(1);
    });
    proc.on("close", (code) => finish(code ?? 0));

    if (opts.signal) {
      const sig = opts.signal;
      if (sig.aborted) {
        aborted = true;
        killTree(proc.pid!);
      } else {
        sig.addEventListener(
          "abort",
          () => {
            aborted = true;
            killTree(proc.pid!);
          },
          { once: true },
        );
      }
    }
  });
}
