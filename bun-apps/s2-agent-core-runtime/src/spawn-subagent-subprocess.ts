/**
 * `spawnSubagentSubprocess()` — the subprocess analog of `spawnSubagent()`.
 *
 * Some callers need PROCESS ISOLATION for their subagent (a clean pi process,
 * separate cwd, crash isolation): obsidian's Zettelkasten distill/garden
 * (wayfind ticket 04) + tool-gate's L2 A/B testing. `spawnSubagent` runs
 * in-process (WorkflowAgent → createAgentSession) which cannot provide that
 * isolation. This wrapper spawns `pi -p --mode json` as a CHILD PROCESS —
 * preserving isolation — WHILE providing the same contract guarantees:
 *   §2 model resolved from config (no hardcodes),
 *   §3 retry-on-transient + timeoutMs,
 *   (§4 phantom telemetry — slice 2; tracked in ticket 04).
 *
 * The return shape MIRRORS `SpawnSubagentResult` so a caller can swap
 * `spawnSubagent` ↔ `spawnSubagentSubprocess` with minimal change.
 *
 * Extraction target: obsidian's `src/lib/subagent.ts` (getPiInvocation /
 * buildSubagentArgs / runSubagent / runSubagentWithRetry / isTransientError),
 * generalized: model from config (not OB_ env), injectable `spawn` for tests,
 * caller-specified extensions/tools/system-prompt.
 */

import { spawn as realSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getEffectiveModelTierConfig, resolveModelRole } from "./model-role-config.js";
import type { SpawnSubagentResult } from "./spawn-subagent.js";
import type { SubagentInFlightRegistry } from "./subagent-in-flight.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";

// ---- Injectable child-process surface (tests pass a mock) ----------------

export interface ChildProcessLike {
  stdout?: { on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  killed: boolean;
  kill(signal?: string): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; shell?: boolean; stdio?: unknown },
) => ChildProcessLike;

// ---- Pure helpers (unit-tested without spawning) -------------------------

/**
 * Resolve the `pi` launcher + args for a child process — the pure, unit-tested
 * core. ALWAYS self-resolves from the parent's own runtime + entry; it NEVER
 * spawns a bare `"pi"` from PATH (that was a silent ENOENT failure mode — a
 * `pi` shim can point at the wrong worktree/version, so relying on it is a
 * hidden correctness hazard). Branches:
 *   1. `currentScript` is a real file on disk (dev `bun src/cli.ts`, dist
 *      `bun s2-agent.js` — every produced launcher execs bun with the
 *      bundle, so this is the only success shape) → `execPath` +
 *      `[currentScript, ...extra]`.
 *   2. otherwise → THROW. Self-resolution is impossible and we refuse to fall
 *      back to a PATH lookup, surfacing the problem loudly instead of silently.
 *
 * (Two earlier branches were deleted with the retired `bun build --compile`
 * mode — crossos-deploy ticket 07, 2026-08-27: the `/$bunfs/root/` virtual-fs
 * special case, and the "non-node/bun exec IS its own entry" fallback that
 * only a compiled artifact could produce.)
 *
 * `entryPrefix` (optional) is a namespace token spliced in front of the pi
 * flags — see the comment in the body.
 *
 * Generalized from pi-obsidian's `getPiInvocation`.
 */
export function resolvePiInvocation(
  currentScript: string | undefined,
  execPath: string,
  extra: string[],
  entryPrefix?: string,
): { command: string; args: string[] } {
  // A host whose entry namespaces its non-interactive mode behind a token (e.g.
  // s2-agent's `cli`) sets PI_SELF_ENTRY_PREFIX so the child re-enters the SAME
  // mode as the parent. Without it a CLI-parented child would land on the host's
  // default (TUI/print) entry and inherit an extension set the parent curated away.
  const prefix = entryPrefix ? [entryPrefix] : [];
  if (currentScript && existsSync(currentScript)) {
    return { command: execPath, args: [currentScript, ...prefix, ...extra] };
  }
  const execName = (execPath.split(sep).pop() ?? "").toLowerCase();
  throw new Error(
    `cannot self-resolve a pi entry for the subprocess subagent — refusing to fall back to a bare "pi" on PATH. ` +
      `currentScript=${currentScript ?? "(none)"}, ` +
      `execPath=${execPath} (runtime=${execName}). ` +
      `Run via \`bun <cli.ts|bundle.js>\` so the child can reuse the parent's entry.`,
  );
}

/**
 * Bind `resolvePiInvocation` to the live process. Thin wrapper so the pure
 * resolver stays unit-testable without touching `process.*`.
 */
export function getPiInvocation(extra: string[]): { command: string; args: string[] } {
  return resolvePiInvocation(
    process.argv[1],
    process.execPath,
    extra,
    // `|| undefined`, not `?? undefined`: an EMPTY env var must mean "no prefix",
    // not a literal "" token spliced into the child argv.
    process.env.PI_SELF_ENTRY_PREFIX || undefined,
  );
}

/** Options for the child pi argv. All optional — caller controls everything. */
export interface SubprocessArgsOptions {
  /** Extension roots to load in the child via `-e` (repeatable). */
  extensions?: string[];
  /** Tool allowlist → `--tools <csv>`. */
  tools?: string[];
  /** Tool denylist → `--exclude-tools <csv>`. */
  excludeTools?: string[];
  /** Resolved model spec (`provider/id[:thinking]`) → `--model`. */
  model?: string;
}

/**
 * Build the pi-compatible argv for a subprocess subagent. Pure — unit-tested
 * without spawning. The caller appends the task (positional) as the last arg.
 * Generalized from pi-obsidian's `buildSubagentArgs` (no obsidian-specific bits).
 */
export function buildSubagentArgs(promptPath: string | undefined, opts: SubprocessArgsOptions = {}): string[] {
  const args = ["--mode", "json", "-p", "--no-session", "--approve"];
  for (const ext of opts.extensions ?? []) {
    args.push("-e", ext);
  }
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", opts.tools.join(","));
  }
  if (promptPath) {
    args.push("--append-system-prompt", promptPath);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.excludeTools && opts.excludeTools.length > 0) {
    args.push("--exclude-tools", opts.excludeTools.join(","));
  }
  return args;
}

/**
 * Heuristic: does this failure message indicate a transient (retryable) failure?
 *
 * Takes only the message: the old second parameter existed to answer "did this
 * even fail?" via `exitCode === 0`, which the caller now knows from the presence
 * of `result.failure` before it ever calls in.
 */
export function isTransientError(message: string): boolean {
  if (!message) return false;
  const s = message.toLowerCase();
  const signals = [
    "etimedout",
    "econnreset",
    "econnrefused",
    "enotfound",
    "socket hang up",
    "timeout",
    "rate limit",
    "429",
    "503",
    "502",
    "network",
    "fetch failed",
    "eai_again",
  ];
  return signals.some((sig) => s.includes(sig));
}

/** Truncate a task prompt for display (in-flight taskPreview). */
function taskPreview(task: string): string {
  const s = task.trim().replace(/\s+/g, " ");
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

// ---- Options + runner -----------------------------------------------------

export interface SpawnSubagentSubprocessOptions {
  /** The task / prompt (positional, last arg). */
  task: string;
  /** System prompt → written to a temp file, passed via --append-system-prompt. */
  systemPrompt?: string;
  /** Extension roots to load in the child (`-e`). */
  extensions?: string[];
  /** Tool allowlist / denylist. */
  tools?: string[];
  excludeTools?: string[];
  /** Model spec — precedence: model > capability > tier > mainModel (§2). */
  model?: string;
  tier?: string;
  capability?: string;
  /** Fallback when none of model/tier/capability set. */
  mainModel?: string;
  cwd?: string;
  /** §3: default 5 min. 0 = no timeout gate. */
  timeoutMs?: number;
  /** §3: retry once on a transient failure. Default true. */
  retryOnTransient?: boolean;
  /** Host signal that cancels the child (SIGTERM → 5s grace → SIGKILL). */
  externalSignal?: AbortSignal;
  /** Live NDJSON-event observer (progress logging). */
  onEvent?: (event: any) => void;
  /** Injectable spawn (tests). Default: node:child_process spawn. */
  spawnFn?: SpawnFn;
  /** §4: in-flight registry — register a phantom entry visible to /subagents. Opt-in. */
  inFlight?: SubagentInFlightRegistry;
  /** §4: persist the completed run (visible in /subagents completed list). Opt-in. */
  persistence?: SubagentRunPersistence;
  /** Run id (inFlight + persistence); default: generated. */
  runId?: string;
}

/** Default timeout: 5 minutes (matches pi-obsidian's OB_SUBAGENT_TIMEOUT_MS). */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Grace period before SIGKILL after SIGTERM. */
const KILL_GRACE_MS = 5000;

export async function spawnSubagentSubprocess(opts: SpawnSubagentSubprocessOptions): Promise<SpawnSubagentResult> {
  const spawnFn: SpawnFn =
    opts.spawnFn ?? ((cmd, args, o) => realSpawn(cmd, args, o as never) as unknown as ChildProcessLike);
  const retry = opts.retryOnTransient !== false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // §2: resolve the model from config (no hardcodes). Precedence mirrors
  // spawnSubagent: model > capability > tier > mainModel.
  const cfg = getEffectiveModelTierConfig();
  const tierSpec = opts.tier ? resolveModelRole({ tier: opts.tier }, cfg) : undefined;
  const capabilitySpec = opts.capability ? resolveModelRole({ capability: opts.capability }, cfg) : undefined;
  if (opts.capability && !capabilitySpec) {
    const known = cfg?.capabilities ? Object.keys(cfg.capabilities).join(", ") || "(none)" : "(none)";
    console.error(
      `[subagent] unknown capability "${opts.capability}" — falling back. Configured capabilities: ${known}.`,
    );
  }
  const effectiveModel = opts.model ?? capabilitySpec ?? tierSpec ?? opts.mainModel;

  const runOnce = async (): Promise<SpawnSubagentResult> => {
    let tmpDir: string | null = null;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      let promptPath: string | undefined;
      if (opts.systemPrompt) {
        tmpDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
        promptPath = join(tmpDir, "system.md");
        await writeFile(promptPath, opts.systemPrompt, { mode: 0o600 });
      }
      const args = [
        ...buildSubagentArgs(promptPath, {
          extensions: opts.extensions,
          tools: opts.tools,
          excludeTools: opts.excludeTools,
          model: effectiveModel,
        }),
        opts.task,
      ];
      const inv = getPiInvocation(args);
      const proc = spawnFn(inv.command, inv.args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const completion = new Promise<{ exitCode: number; stderr: string; text: string }>((resolveDone, rejectDone) => {
        let buf = "";
        let stderr = "";
        let lastText = "";
        const handle = (line: string) => {
          if (!line.trim()) return;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          opts.onEvent?.(ev);
          if (ev.type === "message_end" && ev.message?.role === "assistant") {
            for (const part of ev.message.content ?? []) {
              if (part.type === "text" && part.text) lastText = part.text;
            }
          }
        };
        proc.stdout?.on("data", (d) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) handle(l);
        });
        proc.stderr?.on("data", (d) => {
          stderr += d.toString();
        });
        proc.on("close", (c) => {
          if (buf.trim()) handle(buf);
          resolveDone({ exitCode: c ?? 0, stderr, text: lastText });
        });
        proc.on("error", (e) => rejectDone(e));
      });

      // externalSignal: SIGTERM → grace → SIGKILL.
      const killChild = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, KILL_GRACE_MS);
      };
      if (opts.externalSignal) {
        if (opts.externalSignal.aborted) killChild();
        else opts.externalSignal.addEventListener("abort", killChild, { once: true });
      }
      // timeoutMs gate (§3): SIGTERM → grace → SIGKILL.
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killChild();
        }, timeoutMs);
      }

      let outcome: { exitCode: number; stderr: string; text: string };
      try {
        outcome = await completion;
      } catch (e) {
        // spawn error (e.g. ENOENT — `pi` not on PATH).
        const msg = e instanceof Error ? e.message : String(e);
        return { output: "", failure: { kind: timedOut ? "timedout" : "failed", message: msg } };
      }
      // A timeout kill wins over the exit code: a SIGTERM'd child reports a null
      // close code, which would otherwise read as a clean exit 0. Partial output
      // is preserved alongside the failure either way.
      if (timedOut) {
        return { output: outcome.text, failure: { kind: "timedout", message: outcome.stderr || "timed out" } };
      }
      if (outcome.exitCode !== 0) {
        // The real process exit code is genuine here, unlike on the in-process
        // path — but nothing reads it, so it folds into the message rather than
        // widening the interface both adapters share.
        const detail = outcome.stderr ? `: ${outcome.stderr}` : "";
        return {
          output: outcome.text,
          failure: { kind: "failed", message: `pi exited with code ${outcome.exitCode}${detail}` },
        };
      }
      return { output: outcome.text };
    } finally {
      if (timer) clearTimeout(timer);
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  // §4: register a host-side phantom entry (visible to /subagents). Opt-in —
  // when inFlight/persistence are unset, no telemetry is registered (slice-1
  // default). Consumers (05/06) pass the singletons to satisfy contract §4.
  const runId = opts.runId ?? generateSubagentRunId();
  const t0 = Date.now();
  const displayModel = effectiveModel ?? "default";
  opts.inFlight?.start({
    id: runId,
    model: displayModel,
    taskPreview: taskPreview(opts.task),
    startedAt: t0,
  });

  try {
    const first = await runOnce();
    let result: SpawnSubagentResult = first;
    // No retry on success, caller-cancel, timeout, or when retry is off.
    // Single retry on a transient failure with no useful output (mirrors
    // pi-obsidian's runSubagentWithRetry).
    if (
      first.failure &&
      retry &&
      first.failure.kind !== "timedout" &&
      !opts.externalSignal?.aborted &&
      !first.output &&
      isTransientError(first.failure.message)
    ) {
      result = await runOnce();
    }
    // §4: persist the completed run (best-effort — never throws).
    opts.persistence?.save({
      id: runId,
      toolCallId: runId,
      task: opts.task,
      model: displayModel,
      cwd: opts.cwd ?? process.cwd(),
      status: result.failure?.kind ?? "done",
      error: result.failure?.message,
      startedAt: new Date(t0).toISOString(),
      elapsedMs: Date.now() - t0,
      output: result.output,
    });
    return result;
  } finally {
    opts.inFlight?.end(runId);
  }
}
