import { describe, test, expect } from "bun:test";
import {
  buildMovieHostFnEntries,
  buildMovieHostFnRegistry,
  HOST_FN_TIMEOUT_MS,
} from "./host-fns.ts";
import { COMMANDS } from "./dispatch.ts";

const ctx = () => ({ cwd: process.cwd(), signal: new AbortController().signal, runId: "test" });

describe("movie.* host-fns", () => {
  const entries = buildMovieHostFnEntries();
  const names = entries.map((e) => `${e.ns}.${e.name}`);

  test("registers every dispatch command as movie.<command>", () => {
    for (const cmd of COMMANDS) expect(names).toContain(`movie.${cmd}`);
  });

  test("escape hatch movie.dispatch is present", () => {
    expect(names).toContain("movie.dispatch");
  });

  test("all names match host-fn NAME_RE (ns.name, lowercase alnum+hyphen)", () => {
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/i);
  });

  test("generate has a long timeout (GPU work)", () => {
    expect(HOST_FN_TIMEOUT_MS.generate).toBeGreaterThanOrEqual(600_000);
  });

  test("compose-motion / compose-remotion / compose-hyperframes / compose have long timeouts", () => {
    for (const c of ["compose-motion", "compose-remotion", "compose-hyperframes", "compose"]) {
      expect(HOST_FN_TIMEOUT_MS[c]).toBeGreaterThanOrEqual(900_000);
    }
  });

  test("fn routes to dispatch and returns parsed JSON on ok", async () => {
    const fn = entries.find((e) => e.name === "pipeline-list")!.fn;
    const res = await fn({}, ctx());
    expect(Array.isArray(res)).toBe(true);
    expect(res).toContain("talking-head");
  });

  test("fn throws on dispatch error (missing required fields)", async () => {
    const fn = entries.find((e) => e.name === "init-project")!.fn;
    // init-project with {} → dispatch returns {ok:false, error:"init-project requires non-empty projectId, pipeline"}
    await expect(fn({}, ctx())).rejects.toThrow(/init-project/);
  });

  test("movie.dispatch escape hatch routes {command, options}", async () => {
    const fn = entries.find((e) => e.name === "dispatch")!.fn;
    const res = await fn({ command: "pipeline-list", options: {} }, ctx());
    expect(Array.isArray(res)).toBe(true);
  });
});

describe("buildMovieHostFnRegistry (duck-typed, for runWorkflow hostFns)", () => {
  test("exposes get/has/list — the shape call-global reads", () => {
    const reg = buildMovieHostFnRegistry();
    expect(typeof reg.get).toBe("function");
    expect(typeof reg.has).toBe("function");
    expect(Array.isArray(reg.list())).toBe(true);
  });

  test("list() contains every movie.<command> + movie.dispatch", () => {
    const reg = buildMovieHostFnRegistry();
    const listed = reg.list();
    for (const cmd of COMMANDS) expect(listed).toContain(`movie.${cmd}`);
    expect(listed).toContain("movie.dispatch");
  });

  test("get() returns the {fn,schema?,timeoutMs?} entry for a known name", () => {
    const reg = buildMovieHostFnRegistry();
    const entry = reg.get("movie.generate");
    expect(entry).toBeDefined();
    expect(typeof entry!.fn).toBe("function");
    expect(entry!.timeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  test("get() returns undefined for an unknown name", () => {
    const reg = buildMovieHostFnRegistry();
    expect(reg.get("movie.__nope__")).toBeUndefined();
  });

  test("the registry actually drives call('movie.pipeline-list') end-to-end", async () => {
    const reg = buildMovieHostFnRegistry();
    const entry = reg.get("movie.pipeline-list");
    const res = await entry!.fn({}, ctx());
    expect(res).toContain("talking-head");
  });
});
