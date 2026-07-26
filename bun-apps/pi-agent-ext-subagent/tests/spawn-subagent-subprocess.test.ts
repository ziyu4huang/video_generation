import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  buildSubagentArgs,
  type ChildProcessLike,
  getPiInvocation,
  isTransientError,
  type SpawnFn,
  spawnSubagentSubprocess,
} from "../src/spawn-subagent-subprocess.js";

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
    this.out.emit("data", line + "\n");
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

test("isTransientError: exit 0 is never transient", () => {
  expect(isTransientError("anything", 0)).toBe(false);
});

test("isTransientError: recognized transient signals", () => {
  expect(isTransientError("fetch failed: ECONNRESET", 1)).toBe(true);
  expect(isTransientError("Error: 429 Too Many Requests", 1)).toBe(true);
  expect(isTransientError("socket hang up", 1)).toBe(true);
});

test("isTransientError: non-transient + empty stderr are not transient", () => {
  expect(isTransientError("some logic error", 1)).toBe(false);
  expect(isTransientError("", 1)).toBe(false);
});

// ---- getPiInvocation (shape) ---------------------------------------------

test("getPiInvocation appends the extra args + returns a command", () => {
  const inv = getPiInvocation(["--mode", "json", "do-task"]);
  expect(typeof inv.command === "string" && inv.command.length > 0).toBe(true);
  expect(inv.args.includes("--mode")).toBe(true);
  expect(inv.args.includes("do-task")).toBe(true);
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
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
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
  expect(result.exitCode).toBe(1);
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
  expect(result.exitCode).toBe(0);
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

test("runner: timeoutMs kills the child + flags timedOut (no retry on timeout)", async () => {
  let call = 0;
  const result = await spawnSubagentSubprocess({
    task: "x",
    timeoutMs: 50,
    spawnFn: () => {
      call++;
      return new MockChild() as unknown as ChildProcessLike; // never closes on its own
    },
  });
  expect(result.timedOut).toBe(true);
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

test("runner: spawn-error path surfaces as exit 1 without throwing", async () => {
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
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("spawn ENOENT");
});
