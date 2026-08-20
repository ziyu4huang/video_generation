/**
 * webui-config.test.ts — the optionality gate (architecture v2 §3.1).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
  isWebuiDisabled,
  resolveFileRoots,
  resolveWebuiEnabled,
} from "../src/webui-config.js";

describe("isWebuiDisabled", () => {
  it("false when WEBUI_DISABLED is absent", () => {
    expect(isWebuiDisabled({})).toBe(false);
  });

  it("false when WEBUI_DISABLED is empty", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "" })).toBe(false);
  });

  it("true for '1'", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "1" })).toBe(true);
  });

  it("true for 'true' (case-insensitive)", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "TRUE" })).toBe(true);
  });

  it("false for any other value ('0', 'yes', 'on')", () => {
    expect(isWebuiDisabled({ WEBUI_DISABLED: "0" })).toBe(false);
    expect(isWebuiDisabled({ WEBUI_DISABLED: "yes" })).toBe(false);
    expect(isWebuiDisabled({ WEBUI_DISABLED: "on" })).toBe(false);
  });

  it("defaults to process.env when no arg given", () => {
    expect(typeof isWebuiDisabled()).toBe("boolean");
  });
});

describe("resolveWebuiEnabled", () => {
  it("env alone: enabled by default, disabled by WEBUI_DISABLED", () => {
    expect(resolveWebuiEnabled({})).toBe(true);
    expect(resolveWebuiEnabled({ WEBUI_DISABLED: "1" })).toBe(false);
  });

  it("explicit override wins over env (both directions)", () => {
    expect(resolveWebuiEnabled({ WEBUI_DISABLED: "1" }, true)).toBe(true);
    expect(resolveWebuiEnabled({}, false)).toBe(false);
  });
});

describe("resolveFileRoots (ticket 06, archify-webui-html)", () => {
  it("default [] when neither explicit nor env is set (fail closed)", () => {
    expect(resolveFileRoots({})).toEqual([]);
  });

  it("env empty string -> []", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "" })).toEqual([]);
  });

  it("env splits on ':', trims, and drops empty segments", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "/a : /b:: :/c:" })).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
  });

  it("absolute env roots pass through untouched", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "/abs/root" })).toEqual(["/abs/root"]);
  });

  it("relative env roots are resolved vs cwd", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "rel/dir" })).toEqual([
      path.resolve(process.cwd(), "rel/dir"),
    ]);
  });

  it("explicit array wins over env (precedence: wiring > env)", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "/env" }, ["/explicit"])).toEqual([
      "/explicit",
    ]);
  });

  it("explicit EMPTY array honored (fail closed on purpose) even with env set", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "/env" }, [])).toEqual([]);
  });

  it("explicit entries are trimmed and empty entries dropped, like env", () => {
    expect(resolveFileRoots({}, [" /x ", "", "  "])).toEqual(["/x"]);
  });

  it("relative explicit entries are resolved vs cwd", () => {
    expect(resolveFileRoots({}, ["rel"])).toEqual([path.resolve(process.cwd(), "rel")]);
  });

  it("duplicate roots are deduped AFTER resolution (first occurrence keeps its index — first-match-wins)", () => {
    expect(resolveFileRoots({ WEBUI_FILE_ROOTS: "/a:/b:/a" })).toEqual(["/a", "/b"]);
    expect(resolveFileRoots({}, ["/x", "/y", "/x"])).toEqual(["/x", "/y"]);
  });

  it("dedupe compares RESOLVED paths: a relative root equal to an absolute one collapses", () => {
    const abs = path.resolve(process.cwd(), "rel/dir");
    expect(resolveFileRoots({}, ["rel/dir", abs])).toEqual([abs]);
  });
});
