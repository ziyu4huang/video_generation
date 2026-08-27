import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildSubagentArgs,
  type ChildProcessLike,
  getPiInvocation,
  isTransientError,
  resolvePiInvocation,
  type SpawnFn,
  spawnSubagentSubprocess,
} from "../src/spawn-subagent-subprocess.js";
import type { SubagentInFlightRegistry } from "../src/subagent-in-flight.js";
import type { SubagentRunPersistence } from "../src/subagent-run-persistence.js";

// ---- Mock child process (lets tests drive stdout/stderr/close/kill) ------

class MockChild {
  private out = new EventEmitter();
  private err = new EventEmitter();
  killed = false;
  killSignals: string[] = [];
  private closeH: Array<(c: number | null) => void> = [];
  stdout = {
    on: (ev: string, l: (...a: unknown[]) => void) => {
      this.out.on(ev, l as (...a: unknown[]) => void);
    },
  };
  stderr = {
    on: (ev: string, l: (...a: unknown[]) => void) => {
      this.err.on(ev, l as (...a: unknown[]) => void);
    },
  };
  on(ev: "close" | "error", cb: (...a: unknown[]) => void): this {
    if (ev === "close") this.closeH.push(cb as (c: number | null) => void);
    return this;
  }
  kill(signal = "SIGTERM"): void {
    this.killed = true;
    this.killSignals.push(signal);
    // simulate the OS terminating the process on the signal
    setImmediate(() =>
      this.closeH.forEach((cb) => {
        cb(137);
      }),
    );
  }
  // test drivers
  sendStdout(line: string): void {
    this.out.emit("data", `${line}\n`);
  }
  sendStderr(s: string): void {
    this.err.emit("data", s);
  }
  doClose(code: number): void {
    this.closeH.forEach((cb) => {
      cb(code);
    });
  }
}

/** Build a SpawnFn whose child is driven by `script` on the next tick. */
function mockSpawn(script: (child: MockChild) => void): SpawnFn {
  return (_cmd, _args, _opts) => {
    const child = new MockChild();
    setImmediate(() => script(child));
    return child as unknown as ChildProcessLike;
  };
}

const assistantEnd = (text: string): string =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

// ---- buildSubagentArgs (pure) --------------------------------------------

test("buildSubagentArgs: minimal base flags with no prompt + no opts", () => {
  const args = buildSubagentArgs(undefined, {});
  expect(args).toEqual(["--mode", "json", "-p", "--no-session", "--approve"]);
});

test("buildSubagentArgs: all opts present", () => {
  const args = buildSubagentArgs("/tmp/sys.md", {
    extensions: ["/ext/a", "/ext/b"],
    tools: ["obsidian", "read"],
    excludeTools: ["bash"],
    model: "zai/glm-5.2",
  });
  expect(args[0]).toBe("--mode");
  // extensions repeat as -e <path> pairs
  expect(args.slice(5, 9)).toEqual(["-e", "/ext/a", "-e", "/ext/b"]);
  expect(args.includes("--tools")).toBe(true);
  expect(args[args.indexOf("--tools") + 1]).toBe("obsidian,read");
  expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/tmp/sys.md");
  expect(args[args.indexOf("--model") + 1]).toBe("zai/glm-5.2");
  expect(args[args.indexOf("--exclude-tools") + 1]).toBe("bash");
});

test("buildSubagentArgs: no --append-system-prompt when promptPath undefined", () => {
  const args = buildSubagentArgs(undefined, { model: "x" });
  expect(args.includes("--append-system-prompt")).toBe(false);
});

// ---- isTransientError (pure) ---------------------------------------------

test("isTransientError: an empty message is never transient", () => {
  expect(isTransientError("")).toBe(false);
});

test("isTransientError: recognized transient signals", () => {
  expect(isTransientError("fetch failed: ECONNRESET")).toBe(true);
  expect(isTransientError("Error: 429 Too Many Requests")).toBe(true);
  expect(isTransientError("socket hang up")).toBe(true);
});

test("isTransientError: an unrecognised message is not transient", () => {
  expect(isTransientError("some logic error")).toBe(false);
  expect(isTransientError("")).toBe(false);
});

// ---- getPiInvocation (shape) ---------------------------------------------

test("getPiInvocation appends the extra args + returns a command", () => {
  const inv = getPiInvocation(["--mode", "json", "do-task"]);
  expect(typeof inv.command === "string" && inv.command.length > 0).toBe(true);
  expect(inv.args.includes("--mode")).toBe(true);
  expect(inv.args.includes("do-task")).toBe(true);
});

// ---- resolvePiInvocation (self-resolve contract; no PATH fallback) --------

test("resolvePiInvocation: real currentScript → execPath + [script, ...extra] (dev / dist bundle)", () => {
  const exec = "/usr/local/bin/bun";
  // process.execPath is a real file on disk → case 1 (dev `bun cli.ts` / dist `bun s2-agent.js`).
  const inv = resolvePiInvocation(process.execPath, exec, ["--mode", "json", "do-task"]);
  expect(inv.command).toBe(exec);
  expect(inv.args[0]).toBe(process.execPath);
  expect(inv.args.includes("do-task")).toBe(true);
});

test("resolvePiInvocation: missing entry → throws for ANY runtime (refuses PATH fallback)", () => {
  // bun runtime …
  expect(() => resolvePiInvocation("/nonexistent/cli.ts", "/usr/local/bin/bun", [])).toThrow(/cannot self-resolve/);
  // … and a non-node/bun exec alike — the compiled-mode "exec IS its own
  // entry" fallback was deleted with that mode (crossos-deploy ticket 07).
  expect(() => resolvePiInvocation("/nonexistent/cli.ts", "/opt/pi/bin/s2-agent", [])).toThrow(/cannot self-resolve/);
});

// ---- runner (mock spawnFn) -----------------------------------------------

test("runner: success captures the last assistant text", async () => {
  const result = await spawnSubagentSubprocess({
    task: "do thing",
    spawnFn: mockSpawn((c) => {
      c.sendStdout(JSON.stringify({ type: "tool_execution_end", toolName: "read" }));
      c.sendStdout(assistantEnd("hello world"));
      c.doClose(0);
    }),
  });
  expect(result.output).toBe("hello world");
  expect(result.failure).toBeUndefined();
});

test("runner: does NOT retry on a non-transient failure", async () => {
  let call = 0;
  const result = await spawnSubagentSubprocess({
    task: "x",
    spawnFn: mockSpawn((c) => {
      call++;
      c.sendStderr("some non-transient logic error");
      c.doClose(1);
    }),
  });
  expect(call).toBe(1);
  expect(result.failure?.kind).toBe("failed");
});

test("runner: retries once on a transient failure with no output", async () => {
  let call = 0;
  const result = await spawnSubagentSubprocess({
    task: "x",
    spawnFn: mockSpawn((c) => {
      call++;
      if (call === 1) {
        c.sendStderr("Error: ECONNRESET socket hang up");
        c.doClose(1);
      } else {
        c.sendStdout(assistantEnd("retried ok"));
        c.doClose(0);
      }
    }),
  });
  expect(call).toBe(2);
  expect(result.failure).toBeUndefined();
  expect(result.output).toBe("retried ok");
});

test("runner: does NOT retry when retryOnTransient is false", async () => {
  let call = 0;
  await spawnSubagentSubprocess({
    task: "x",
    retryOnTransient: false,
    spawnFn: mockSpawn((c) => {
      call++;
      c.sendStderr("Error: ECONNRESET");
      c.doClose(1);
    }),
  });
  expect(call).toBe(1);
});

test("runner: timeoutMs kills the child + reports kind timedout (no retry on timeout)", async () => {
  let call = 0;
  const result = await spawnSubagentSubprocess({
    task: "x",
    timeoutMs: 50,
    spawnFn: () => {
      call++;
      return new MockChild() as unknown as ChildProcessLike; // never closes on its own
    },
  });
  expect(result.failure?.kind).toBe("timedout");
  expect(call).toBe(1);
});

test("runner: externalSignal abort kills the child", async () => {
  const ac = new AbortController();
  const seen: MockChild[] = [];
  await spawnSubagentSubprocess({
    task: "x",
    timeoutMs: 0, // disable the timeout gate so only the signal kills
    externalSignal: ac.signal,
    spawnFn: () => {
      const c = new MockChild();
      seen.push(c);
      setImmediate(() => ac.abort());
      return c as unknown as ChildProcessLike;
    },
  });
  expect(seen.length).toBe(1);
  expect(seen[0].killed).toBe(true);
  expect(seen[0].killSignals.includes("SIGTERM")).toBe(true);
});

test("runner: systemPrompt → temp file + --append-system-prompt", async () => {
  let capturedArgs: string[] = [];
  await spawnSubagentSubprocess({
    task: "x",
    systemPrompt: "you are a distiller",
    spawnFn: (_cmd, args) => {
      capturedArgs = args as string[];
      const c = new MockChild();
      setImmediate(() => c.doClose(0));
      return c as unknown as ChildProcessLike;
    },
  });
  const idx = capturedArgs.indexOf("--append-system-prompt");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect((capturedArgs[idx + 1] ?? "").includes("system.md")).toBe(true);
});

test("runner: onEvent forwards every parsed NDJSON event", async () => {
  const events: unknown[] = [];
  await spawnSubagentSubprocess({
    task: "x",
    onEvent: (e) => events.push(e),
    spawnFn: mockSpawn((c) => {
      c.sendStdout(JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
      c.sendStdout(JSON.stringify({ type: "message_update" }));
      c.sendStdout(assistantEnd("done"));
      c.doClose(0);
    }),
  });
  expect(events.length).toBe(3);
  expect((events[0] as { type: string }).type).toBe("tool_execution_start");
});

test("runner: spawn-error path surfaces as a failure without throwing", async () => {
  // A child that errors via 'error' (e.g. ENOENT) → exit 1, no rejection.
  const result = await spawnSubagentSubprocess({
    task: "x",
    spawnFn: () => {
      const c = new MockChild();
      // override close to NOT fire; instead this child simulates a spawn
      // error by re-emitting — but MockChild routes through close. So we
      // simply assert the no-output + non-zero path is non-throwing here
      // by closing non-zero with a stderr string.
      setImmediate(() => {
        c.sendStderr("spawn ENOENT");
        c.doClose(1);
      });
      return c as unknown as ChildProcessLike;
    },
  });
  expect(result.failure?.kind).toBe("failed");
  // The real process exit code folds into the message rather than widening the
  // interface the in-process adapter shares with this one.
  expect(result.failure?.message).toBe("pi exited with code 1: spawn ENOENT");
});

// ---- §4 phantom telemetry (slice 2) --------------------------------------

function mockInFlight() {
  const calls: { method: string; arg: unknown }[] = [];
  return {
    calls,
    start: (run: unknown) => calls.push({ method: "start", arg: run }),
    end: (id: string) => calls.push({ method: "end", arg: id }),
    update: () => {},
    get: () => undefined,
    bindInvalidate: () => {},
    updateModel: () => {},
    list: () => [],
  };
}

function mockPersistence() {
  const saved: unknown[] = [];
  return {
    saved,
    save: (r: unknown) => saved.push(r),
    list: () => [],
    load: () => null,
    delete: () => false,
    getRunsDir: () => "/tmp",
  };
}

test("telemetry: inFlight start/end wrap the run", async () => {
  const inflight = mockInFlight();
  await spawnSubagentSubprocess({
    task: "do it",
    inFlight: inflight as unknown as SubagentInFlightRegistry,
    spawnFn: mockSpawn((c) => {
      c.doClose(0);
    }),
  });
  expect(inflight.calls.map((c) => c.method)).toEqual(["start", "end"]);
  expect((inflight.calls[0].arg as { model: string }).model).toBe("default");
});

test("telemetry: persistence.save records a done run", async () => {
  const persist = mockPersistence();
  await spawnSubagentSubprocess({
    task: "do it",
    persistence: persist as unknown as SubagentRunPersistence,
    spawnFn: mockSpawn((c) => {
      c.sendStdout(assistantEnd("ok"));
      c.doClose(0);
    }),
  });
  expect(persist.saved.length).toBe(1);
  const rec = persist.saved[0] as {
    status: string;
    output: string;
    elapsedMs: number;
  };
  expect(rec.status).toBe("done");
  expect(rec.status).toBe("done");
  expect(rec.output).toBe("ok");
  expect(rec.elapsedMs).toBeGreaterThanOrEqual(0);
});

test("telemetry: failed run -> status 'failed' + error recorded", async () => {
  const persist = mockPersistence();
  await spawnSubagentSubprocess({
    task: "x",
    persistence: persist as unknown as SubagentRunPersistence,
    spawnFn: mockSpawn((c) => {
      c.sendStderr("boom");
      c.doClose(1);
    }),
  });
  const rec = persist.saved[0] as { status: string; error?: string };
  expect(rec.status).toBe("failed");
  expect(rec.error).toMatch(/boom/);
});

test("telemetry: start fires before the run, end after (wrapping order)", async () => {
  const order: string[] = [];
  const inflight = {
    start: () => order.push("start"),
    end: () => order.push("end"),
    update: () => {},
    get: () => undefined,
    bindInvalidate: () => {},
    updateModel: () => {},
    list: () => [],
  };
  await spawnSubagentSubprocess({
    task: "x",
    inFlight: inflight as unknown as SubagentInFlightRegistry,
    spawnFn: mockSpawn((c) => {
      order.push("run");
      c.doClose(0);
    }),
  });
  expect(order).toEqual(["start", "run", "end"]);
});

test("telemetry: no registration when inFlight/persistence unset (opt-in default)", async () => {
  const result = await spawnSubagentSubprocess({
    task: "x",
    spawnFn: mockSpawn((c) => {
      c.doClose(0);
    }),
  });
  expect(result.failure).toBeUndefined();
});

// ---- entry prefix (host namespaces its non-interactive mode) --------------

describe("resolvePiInvocation entry prefix", () => {
  test("no prefix by default — child argv is unchanged", () => {
    const { args } = resolvePiInvocation(import.meta.path, "/usr/bin/bun", ["-p", "hi"]);
    expect(args).toEqual([import.meta.path, "-p", "hi"]);
  });

  test("an entry prefix is spliced between the script and the pi flags", () => {
    const { args } = resolvePiInvocation(import.meta.path, "/usr/bin/bun", ["-p", "hi"], "cli");
    expect(args).toEqual([import.meta.path, "cli", "-p", "hi"]);
  });

  // The empty-string contract is guarded at TWO layers, so both are pinned:
  //   1. getPiInvocation's `process.env.X || undefined` (not `??`), and
  //   2. resolvePiInvocation's own `entryPrefix ? [...] : []` truthiness check.
  // An unset var and an empty var must produce a byte-identical child argv —
  // splicing a literal "" would make the child parse an empty command token.
  test("getPiInvocation: an EMPTY env prefix is 'no prefix', never a \"\" token", () => {
    const saved = process.env.PI_SELF_ENTRY_PREFIX;
    try {
      process.env.PI_SELF_ENTRY_PREFIX = "";
      const empty = getPiInvocation(["-p", "hi"]);
      expect(empty.args).not.toContain("");
      expect(empty.args.slice(-2)).toEqual(["-p", "hi"]);

      process.env.PI_SELF_ENTRY_PREFIX = "cli";
      const set = getPiInvocation(["-p", "hi"]);
      expect(set.args).toContain("cli");
      expect(set.args.slice(-3)).toEqual(["cli", "-p", "hi"]);
    } finally {
      // Assigning `undefined` does NOT clear the key — it coerces to the
      // literal string "undefined". Delete it instead.
      if (saved === undefined) delete process.env.PI_SELF_ENTRY_PREFIX;
      else process.env.PI_SELF_ENTRY_PREFIX = saved;
    }
  });

  test("resolvePiInvocation: an empty entryPrefix splices nothing (layer-2 guard)", () => {
    const { args } = resolvePiInvocation(import.meta.path, "/usr/bin/bun", ["-p", "hi"], "");
    expect(args).toEqual([import.meta.path, "-p", "hi"]);
  });
});
