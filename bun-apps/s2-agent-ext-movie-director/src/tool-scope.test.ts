import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_DENIED_PREFIXES,
  GUARDED_TOOLS,
  REPO_ROOT,
  deniedPrefixes,
  editPathFromToolInput,
  isDeniedEditPath,
  scopeViolationForToolCall,
} from "./tool-scope.ts";
import { markMovieActive, _resetMovieActiveForTests } from "./session-state.ts";

// The guard is a pure function over resolved paths. The repo root in tests is
// the REAL repo root (the extension's grandparent), so the denied-prefix
// fixtures below mirror real paths a wandering agent would target.
const OPTS = { cwd: REPO_ROOT, repoRoot: REPO_ROOT, env: {} } as const;

describe("tool-scope guard — isDeniedEditPath", () => {
  test("the #291 ungrounded edit is denied", () => {
    const v = isDeniedEditPath("python/mlx-movie-director/app/config.py", OPTS);
    expect(v.denied).toBe(true);
    expect(v.prefix).toBe("python/");
  });

  test("every default denied prefix blocks a path beneath it", () => {
    for (const prefix of DEFAULT_DENIED_PREFIXES) {
      const sample = prefix + "some/file.ts";
      expect(isDeniedEditPath(sample, OPTS).denied, prefix).toBe(true);
    }
  });

  test("repo-relative, absolute, and cwd-relative forms all match", () => {
    const rel = isDeniedEditPath("swift/foo/bar.swift", OPTS);
    const abs = isDeniedEditPath(`${REPO_ROOT}/swift/foo/bar.swift`, OPTS);
    const dot = isDeniedEditPath("./swift/foo/bar.swift", OPTS);
    expect(rel.denied).toBe(true);
    expect(abs.denied).toBe(true);
    expect(dot.denied).toBe(true);
  });

  test("path traversal (..) cannot escape the denylist", () => {
    expect(isDeniedEditPath("python/../python/app/x.py", OPTS).denied).toBe(true);
    expect(isDeniedEditPath("bun-apps/../python/x.py", OPTS).denied).toBe(true);
  });

  test("the denied root itself is blocked (not just paths beneath it)", () => {
    expect(isDeniedEditPath("python", OPTS).denied).toBe(true);
    expect(isDeniedEditPath("python/", OPTS).denied).toBe(true);
  });

  test("paths OUTSIDE the repo are allowed (project workspace lives there)", () => {
    expect(isDeniedEditPath("/tmp/movie-director/final.mp4", OPTS).denied).toBe(false);
    expect(isDeniedEditPath("/Users/someone/output/movie-director/projects/p1/assets/a.png", OPTS).denied).toBe(false);
  });

  test("a non-infra repo path is allowed (e.g. a top-level README)", () => {
    expect(isDeniedEditPath("README.md", OPTS).denied).toBe(false);
    expect(isDeniedEditPath("output/receipt.md", OPTS).denied).toBe(false);
  });

  test("MD_TOOL_SCOPE_DISABLE=1 bypasses entirely", () => {
    const env = { MD_TOOL_SCOPE_DISABLE: "1" };
    expect(isDeniedEditPath("python/x.py", { ...OPTS, env }).denied).toBe(false);
  });

  test("MD_TOOL_SCOPE_DISABLE=1 in process.env bypasses even when NO opts.env is passed (the real-hook path)", () => {
    // Reproduces the production wiring: scopeViolationForToolCall(event) calls
    // isDeniedEditPath(path, {}) — no opts.env — so the bypass MUST consult
    // process.env. Before the fix this returned denied:true (the bypass only
    // checked opts.env), blocking all bun-apps/ edits even with the env var set.
    const saved = process.env.MD_TOOL_SCOPE_DISABLE;
    process.env.MD_TOOL_SCOPE_DISABLE = "1";
    try {
      const v = isDeniedEditPath("bun-apps/s2-agent/scripts/deploy.ts", { cwd: REPO_ROOT, repoRoot: REPO_ROOT });
      expect(v.denied).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MD_TOOL_SCOPE_DISABLE;
      else process.env.MD_TOOL_SCOPE_DISABLE = saved;
    }
  });

  test("MD_TOOL_SCOPE_DENY overrides the default list", () => {
    const env = { MD_TOOL_SCOPE_DENY: "python/:mlx-models/" };
    expect(deniedPrefixes(env)).toEqual(["python/", "mlx-models/"]);
    // With override, swift/ is no longer denied.
    expect(isDeniedEditPath("swift/x.swift", { ...OPTS, env }).denied).toBe(false);
    expect(isDeniedEditPath("python/x.py", { ...OPTS, env }).denied).toBe(true);
  });
});

describe("tool-scope guard — editPathFromToolInput", () => {
  test("edit input exposes path", () => {
    expect(editPathFromToolInput("edit", { path: "python/x.py", edits: [] })).toBe("python/x.py");
  });
  test("write input exposes path", () => {
    expect(editPathFromToolInput("write", { path: "swift/y.swift", content: "x" })).toBe("swift/y.swift");
  });
  test("non-string / missing path returns undefined", () => {
    expect(editPathFromToolInput("edit", { edits: [] })).toBeUndefined();
    expect(editPathFromToolInput("write", { path: 42 })).toBeUndefined();
    expect(editPathFromToolInput("edit", null)).toBeUndefined();
  });
});

describe("tool-scope guard — session movie-active gate", () => {
  afterEach(() => _resetMovieActiveForTests());

  test("NO-OP when no movie has run this session (unblocks normal repo work)", () => {
    _resetMovieActiveForTests();
    const v = scopeViolationForToolCall(
      { toolName: "edit", input: { path: "bun-apps/s2-agent/scripts/deploy.ts", edits: [] } },
      OPTS,
    );
    expect(v).toBeUndefined();
  });

  test("markMovieActive() arms the guard (a denied edit now blocks)", () => {
    markMovieActive();
    const v = scopeViolationForToolCall(
      { toolName: "edit", input: { path: "bun-apps/s2-agent/scripts/deploy.ts", edits: [] } },
      OPTS,
    );
    expect(v?.block).toBe(true);
  });

  test("the flag is sticky across calls within the session", () => {
    markMovieActive();
    expect(scopeViolationForToolCall({ toolName: "write", input: { path: "python/x.py", content: "" } }, OPTS)?.block).toBe(true);
    expect(scopeViolationForToolCall({ toolName: "write", input: { path: "python/y.py", content: "" } }, OPTS)?.block).toBe(true);
  });
});

describe("tool-scope guard — scopeViolationForToolCall", () => {
  // These tests exercise the deny logic, which only runs when the guard is
  // armed — so mark a movie active for the whole describe.
  beforeEach(() => markMovieActive());
  afterEach(() => _resetMovieActiveForTests());

  test("blocks an edit into python/", () => {
    const v = scopeViolationForToolCall(
      { toolName: "edit", input: { path: "python/mlx-movie-director/app/config.py", edits: [] } },
      OPTS,
    );
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain("python/");
    expect(v?.reason).toContain("out of scope");
  });

  test("blocks a write into bun-apps/", () => {
    const v = scopeViolationForToolCall(
      { toolName: "write", input: { path: "bun-apps/gui-movie-director/x.ts", content: "x" } },
      OPTS,
    );
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain("bun-apps/");
  });

  test("allows a safe edit (project workspace)", () => {
    const v = scopeViolationForToolCall(
      { toolName: "write", input: { path: "/tmp/movie-director/final.mp4", content: "x" } },
      OPTS,
    );
    expect(v).toBeUndefined();
  });

  test("non-guarded tools are never blocked (read/grep/find/ls/movie)", () => {
    for (const toolName of ["read", "grep", "find", "ls", "movie", "bash"]) {
      expect(scopeViolationForToolCall({ toolName, input: { path: "python/x.py" } }, OPTS), toolName).toBeUndefined();
    }
  });

  test("only edit + write are guarded tools", () => {
    expect([...GUARDED_TOOLS].sort()).toEqual(["edit", "write"]);
  });

  test("malformed edit input (no path) is allowed, not crashed", () => {
    expect(scopeViolationForToolCall({ toolName: "edit", input: { edits: [] } }, OPTS)).toBeUndefined();
  });
});
