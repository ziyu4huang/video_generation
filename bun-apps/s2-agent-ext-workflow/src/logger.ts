/**
 * Workflow logger with file persistence.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { workflowProjectPaths } from "./workflow-paths.js";

export interface WorkflowLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  getLogs(): string[];
  persist(): string | null;
}

export interface WorkflowLoggerOptions {
  /** Run ID for persistence. */
  runId?: string;
  /** Working directory for file paths. */
  cwd?: string;
  /**
   * Directory for the persisted run log. When set, overrides the default
   * (cwd-hashed) runs dir from `workflowProjectPaths`. Absolute, or relative
   * to `cwd`. Lets a headless caller redirect output to `PWD/.pi/` or anywhere.
   */
  runsDir?: string;
  /** Whether to persist logs to disk. */
  persist?: boolean;
  /** Callback for each log entry. */
  onLog?: (message: string) => void;
}

export function createWorkflowLogger(options: WorkflowLoggerOptions = {}): WorkflowLogger {
  const logs: string[] = [];
  const persistLogs = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? `run-${Date.now()}`;
  const runsDir = options.runsDir
    ? isAbsolute(options.runsDir)
      ? options.runsDir
      : resolve(cwd, options.runsDir)
    : workflowProjectPaths(cwd).runsDir;
  let logFile: string | null = null;

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${level}] ${message}`;
    logs.push(entry);
    options.onLog?.(message);

    if (persistLogs && logFile) {
      try {
        appendFileSync(logFile, `${entry}\n`);
      } catch {
        // Silent fail for log persistence
      }
    }
  };

  const logger: WorkflowLogger = {
    log(message: string) {
      write("INFO", message);
    },
    error(message: string) {
      write("ERROR", message);
    },
    warn(message: string) {
      write("WARN", message);
    },
    getLogs() {
      return [...logs];
    },
    persist() {
      if (!persistLogs) return null;
      try {
        mkdirSync(runsDir, { recursive: true });
        logFile = join(runsDir, `${runId}.log`);
        writeFileSync(logFile, `${logs.join("\n")}\n`);
        return logFile;
      } catch {
        return null;
      }
    },
  };

  // Initialize log file if persisting
  if (persistLogs) {
    try {
      mkdirSync(runsDir, { recursive: true });
      logFile = join(runsDir, `${runId}.log`);
    } catch {
      // Silent fail
    }
  }

  return logger;
}
