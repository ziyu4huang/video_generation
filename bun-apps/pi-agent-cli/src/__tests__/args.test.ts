import { test, expect, describe } from "bun:test";
import { parsePiArgs } from "../args.ts";

describe("parsePiArgs — zk-card / zk-ask flags", () => {
  test("--force sets force=true", () => {
    const out = parsePiArgs(["zk-card", "add", "text", "--force"]);
    expect(out.force).toBe(true);
  });

  test("--force not present → force is undefined", () => {
    const out = parsePiArgs(["zk-card", "add", "text"]);
    expect(out.force).toBeUndefined();
  });

  test("--no-context sets noContext=true", () => {
    const out = parsePiArgs(["zk-card", "find", "query", "--no-context"]);
    expect(out.noContext).toBe(true);
  });

  test("--no-context not present → noContext is undefined", () => {
    const out = parsePiArgs(["zk-card", "find", "query"]);
    expect(out.noContext).toBeUndefined();
  });

  test("--context-lines <n> (space form)", () => {
    const out = parsePiArgs(["zk-card", "find", "query", "--context-lines", "5"]);
    expect(out.contextLines).toBe(5);
  });

  test("--context-lines=<n> (= form)", () => {
    const out = parsePiArgs(["--context-lines=7"]);
    expect(out.contextLines).toBe(7);
  });

  test("--context-lines 0 is valid (titles only)", () => {
    const out = parsePiArgs(["--context-lines", "0"]);
    expect(out.contextLines).toBe(0);
  });

  test("--limit <n> (space form)", () => {
    const out = parsePiArgs(["zk-card", "find", "query", "--limit", "20"]);
    expect(out.limit).toBe(20);
  });

  test("--limit=<n> (= form)", () => {
    const out = parsePiArgs(["--limit=3"]);
    expect(out.limit).toBe(3);
  });

  test("--file <path> (space form)", () => {
    const out = parsePiArgs(["zk-card", "add", "--file", "/tmp/concept.txt"]);
    expect(out.file).toBe("/tmp/concept.txt");
  });

  test("--file=<path> (= form)", () => {
    const out = parsePiArgs(["--file=/tmp/note.md"]);
    expect(out.file).toBe("/tmp/note.md");
  });

  // Fix 2: zk-ask numeric flags — falsy-zero + negative validation
  test("--depth 0 is accepted (depth === 0)", () => {
    const out = parsePiArgs(["zk-ask", "q", "--depth", "0"]);
    expect(out.depth).toBe(0);
  });

  test("--depth -1 throws", () => {
    expect(() => parsePiArgs(["zk-ask", "q", "--depth", "-1"])).toThrow(/--depth/);
  });

  test("--depth abc throws", () => {
    expect(() => parsePiArgs(["zk-ask", "q", "--depth", "abc"])).toThrow(/--depth/);
  });

  test("--max-neighbors 0 is accepted", () => {
    const out = parsePiArgs(["zk-ask", "q", "--max-neighbors", "0"]);
    expect(out.maxNeighbors).toBe(0);
  });

  test("--max-neighbors -3 throws", () => {
    expect(() => parsePiArgs(["zk-ask", "q", "--max-neighbors", "-3"])).toThrow(/--max-neighbors/);
  });

  test("--top-k 5 is accepted", () => {
    const out = parsePiArgs(["zk-ask", "q", "--top-k", "5"]);
    expect(out.topK).toBe(5);
  });

  test("--max-note-tokens 500 is accepted", () => {
    const out = parsePiArgs(["zk-ask", "q", "--max-note-tokens", "500"]);
    expect(out.maxNoteTokens).toBe(500);
  });

  test("--no-refine sets noRefine=true", () => {
    const out = parsePiArgs(["zk-ask", "q", "--no-refine"]);
    expect(out.noRefine).toBe(true);
  });

  test("--retrieve-only sets retrieveOnly=true", () => {
    const out = parsePiArgs(["zk-ask", "q", "--retrieve-only"]);
    expect(out.retrieveOnly).toBe(true);
  });

  test("--summarize sets summarize=true", () => {
    const out = parsePiArgs(["zk-ask", "q", "--summarize"]);
    expect(out.summarize).toBe(true);
  });

  test("knowledge flags do not interfere with existing flags", () => {
    const out = parsePiArgs([
      "--model", "sonnet",
      "--force",
      "--limit", "5",
      "--no-context",
      "--context-lines", "2",
      "--file", "x.txt",
      "add", "content",
    ]);
    expect(out.model).toBe("sonnet");
    expect(out.force).toBe(true);
    expect(out.limit).toBe(5);
    expect(out.noContext).toBe(true);
    expect(out.contextLines).toBe(2);
    expect(out.file).toBe("x.txt");
    expect(out.positionals).toEqual(["add", "content"]);
  });
});

describe("parsePiArgs — fail-fast numeric flags (silent-coerce → throw)", () => {
  // These five flags previously used `Number(x) || default`, silently coercing
  // bad input (a typo in --retries abc disabled 429 retries with no error).
  // They now throw like --depth / --top-k. 0 stays legal where meaningful.

  // --- --limit (positive integer; 0 was never reachable, became 10) ---
  test("--limit abc throws (was silently coerced to 10)", () => {
    expect(() => parsePiArgs(["--limit", "abc"])).toThrow(/--limit/);
  });
  test("--limit 0 throws (0 results is meaningless; was silently 10)", () => {
    expect(() => parsePiArgs(["--limit", "0"])).toThrow(/--limit/);
  });
  test("--limit -5 throws", () => {
    expect(() => parsePiArgs(["--limit", "-5"])).toThrow(/--limit/);
  });

  // --- --max-notes (non-negative integer; 0 = unlimited hint) ---
  test("--max-notes abc throws", () => {
    expect(() => parsePiArgs(["--max-notes", "abc"])).toThrow(/--max-notes/);
  });
  test("--max-notes -1 throws", () => {
    expect(() => parsePiArgs(["--max-notes", "-1"])).toThrow(/--max-notes/);
  });
  test("--max-notes 0 is accepted (unlimited)", () => {
    expect(parsePiArgs(["--max-notes", "0"]).maxNotes).toBe(0);
  });

  // --- --context-lines (non-negative integer; 0 = titles only) ---
  test("--context-lines abc throws", () => {
    expect(() => parsePiArgs(["--context-lines", "abc"])).toThrow(/--context-lines/);
  });
  test("--context-lines -2 throws", () => {
    expect(() => parsePiArgs(["--context-lines", "-2"])).toThrow(/--context-lines/);
  });
  // (0 is valid — covered by the earlier "--context-lines 0 is valid" test.)

  // --- --retries (non-negative integer; 0 = no retries) ---
  test("--retries abc throws (was silently 0 → disabled 429 retries)", () => {
    expect(() => parsePiArgs(["--retries", "abc"])).toThrow(/--retries/);
  });
  test("--retries -1 throws", () => {
    expect(() => parsePiArgs(["--retries", "-1"])).toThrow(/--retries/);
  });
  test("--retries 0 is accepted (no retries)", () => {
    expect(parsePiArgs(["--retries", "0"]).retries).toBe(0);
  });

  // --- --retry-wait (non-negative number; seconds, fractional allowed) ---
  test("--retry-wait abc throws", () => {
    expect(() => parsePiArgs(["--retry-wait", "abc"])).toThrow(/--retry-wait/);
  });
  test("--retry-wait -1 throws", () => {
    expect(() => parsePiArgs(["--retry-wait", "-1"])).toThrow(/--retry-wait/);
  });
  test("--retry-wait 0 is accepted (no wait)", () => {
    expect(parsePiArgs(["--retry-wait", "0"]).retryWaitSec).toBe(0);
  });
  test("--retry-wait 1.5 is accepted (fractional seconds)", () => {
    expect(parsePiArgs(["--retry-wait", "1.5"]).retryWaitSec).toBe(1.5);
  });
});

describe("parsePiArgs — verbose flags", () => {
  // The env var is read at emptyParsed() time, so save/restore around each test.
  const envName = "PI_VERBOSE";
  const saved = process.env[envName];
  const clearEnv = () => { delete process.env[envName]; };
  const restoreEnv = () => {
    if (saved === undefined) delete process.env[envName];
    else process.env[envName] = saved;
  };

  test("default → 0", () => {
    clearEnv();
    expect(parsePiArgs(["zk-ask", "q"]).verbose).toBe(0);
  });

  test("-V → 1", () => {
    clearEnv();
    expect(parsePiArgs(["-V", "zk-ask", "q"]).verbose).toBe(1);
  });

  test("-VV → 2 (clamped)", () => {
    clearEnv();
    expect(parsePiArgs(["-VV", "q"]).verbose).toBe(2);
  });

  test("-VVV → 2 (hard clamp)", () => {
    clearEnv();
    expect(parsePiArgs(["-VVV", "q"]).verbose).toBe(2);
  });

  test("--verbose → 1", () => {
    clearEnv();
    expect(parsePiArgs(["--verbose", "q"]).verbose).toBe(1);
  });

  test("--verbose 2 (numeric arg) → 2", () => {
    clearEnv();
    expect(parsePiArgs(["--verbose", "2", "q"]).verbose).toBe(2);
    // numeric arg consumed, not treated as positional
    expect(parsePiArgs(["--verbose", "2", "q"]).positionals).toEqual(["q"]);
  });

  test("--verbose=1 (= form) → 1", () => {
    clearEnv();
    expect(parsePiArgs(["--verbose=1", "q"]).verbose).toBe(1);
  });

  test("--verbose=5 (out of range) → unchanged (0)", () => {
    clearEnv();
    expect(parsePiArgs(["--verbose=5", "q"]).verbose).toBe(0);
  });

  test("repeated -V -V → 2", () => {
    clearEnv();
    expect(parsePiArgs(["-V", "-V", "q"]).verbose).toBe(2);
  });

  test("--debug → 2", () => {
    clearEnv();
    expect(parsePiArgs(["--debug", "q"]).verbose).toBe(2);
  });

  test("PI_VERBOSE=2 env → 2", () => {
    process.env.PI_VERBOSE = "2";
    expect(parsePiArgs(["q"]).verbose).toBe(2);
    clearEnv();
  });

  test("PI_VERBOSE=5 (invalid) → 0", () => {
    process.env.PI_VERBOSE = "5";
    expect(parsePiArgs(["q"]).verbose).toBe(0);
    clearEnv();
  });

  test("-V does NOT collide with -v/--version", () => {
    clearEnv();
    // -v remains version (unchanged by the verbose feature)
    expect(parsePiArgs(["-v"]).version).toBe(true);
    expect(parsePiArgs(["-v"]).verbose).toBe(0);
    restoreEnv();
  });
});

describe("parsePiArgs — `--` end-of-options separator", () => {
  test("tokens after `--` are positional verbatim (flags not parsed)", () => {
    const out = parsePiArgs(["flux2", "--", "t2i", "--prompt", "a red cube"]);
    expect(out.positionals).toEqual(["flux2", "t2i", "--prompt", "a red cube"]);
    // --prompt is NOT consumed as an unknown value flag (no swallowed value)
    expect(out.print).toBe(false);
  });

  test("`--` itself is not a positional", () => {
    const out = parsePiArgs(["--", "prompt"]);
    expect(out.positionals).toEqual(["prompt"]);
  });

  test("`--` protects leading-dash operands", () => {
    const out = parsePiArgs(["--", "-5", "degrees"]);
    expect(out.positionals).toEqual(["-5", "degrees"]);
  });

  test("flags BEFORE `--` still parse normally", () => {
    const out = parsePiArgs(["--model", "sonnet", "flux2", "--", "t2i"]);
    expect(out.model).toBe("sonnet");
    expect(out.positionals).toEqual(["flux2", "t2i"]);
  });

  test("a bare `--` with nothing after → no positionals", () => {
    const out = parsePiArgs(["flux2", "--"]);
    expect(out.positionals).toEqual(["flux2"]);
  });
});
