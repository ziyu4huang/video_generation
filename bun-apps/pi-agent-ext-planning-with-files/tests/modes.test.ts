import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveEffectiveMode, parseMode, resolveAutoApprove, resolveConfiguredMode } from "../src/modes.js";

const tempRoots: string[] = [];
let originalEnv: NodeJS.ProcessEnv;

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-modes-"));
  tempRoots.push(cwd);
  return cwd;
}

beforeEach(() => {
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = { ...originalEnv };
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function ctxWith(provider: string, id: string) {
  return { model: { provider, id } } as never;
}

describe("parseMode", () => {
  it("accepts the four canonical modes", () => {
    expect(parseMode("auto")).toBe("auto");
    expect(parseMode("parity")).toBe("parity");
    expect(parseMode("cache-safe")).toBe("cache-safe");
    expect(parseMode("notify")).toBe("notify");
  });

  it("rejects unknown values", () => {
    expect(parseMode("loud")).toBeUndefined();
    expect(parseMode(undefined)).toBeUndefined();
  });
});

describe("resolveConfiguredMode", () => {
  it("honors PWF_MODE env over settings", () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ planningWithFiles: { mode: "notify" } }));
    process.env.PWF_MODE = "cache-safe";

    expect(resolveConfiguredMode(cwd)).toBe("cache-safe");
  });

  it("reads project settings", () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ planningWithFiles: { mode: "notify" } }));
    delete process.env.PWF_MODE;

    expect(resolveConfiguredMode(cwd)).toBe("notify");
  });

  it("defaults to auto", () => {
    const cwd = makeCwd();
    delete process.env.PWF_MODE;
    expect(resolveConfiguredMode(cwd)).toBe("auto");
  });
});

describe("deriveEffectiveMode", () => {
  it("auto → cache-safe for DeepSeek", () => {
    expect(deriveEffectiveMode("auto", ctxWith("deepseek", "deepseek-chat"))).toBe("cache-safe");
    expect(deriveEffectiveMode("auto", ctxWith("openai", "deepseek-v4"))).toBe("cache-safe");
  });

  it("auto → parity for non-DeepSeek", () => {
    expect(deriveEffectiveMode("auto", ctxWith("openai", "gpt-5"))).toBe("parity");
  });

  it("passes explicit modes through unchanged", () => {
    expect(deriveEffectiveMode("notify", ctxWith("deepseek", "deepseek-chat"))).toBe("notify");
    expect(deriveEffectiveMode("cache-safe", ctxWith("openai", "gpt-5"))).toBe("cache-safe");
  });
});

describe("resolveAutoApprove", () => {
  it("is off by default", () => {
    const cwd = makeCwd();
    delete process.env.PWF_AUTO_APPROVE;
    expect(resolveAutoApprove(cwd)).toBe(false);
  });

  it("is on when PWF_AUTO_APPROVE is truthy", () => {
    const cwd = makeCwd();
    process.env.PWF_AUTO_APPROVE = "1";
    expect(resolveAutoApprove(cwd)).toBe(true);
    process.env.PWF_AUTO_APPROVE = "true";
    expect(resolveAutoApprove(cwd)).toBe(true);
  });

  it("ignores non-truthy values", () => {
    const cwd = makeCwd();
    process.env.PWF_AUTO_APPROVE = "0";
    expect(resolveAutoApprove(cwd)).toBe(false);
    process.env.PWF_AUTO_APPROVE = "no";
    expect(resolveAutoApprove(cwd)).toBe(false);
  });

  it("reads autoApprove from project settings", () => {
    const cwd = makeCwd();
    delete process.env.PWF_AUTO_APPROVE;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ planningWithFiles: { autoApprove: true } }));
    expect(resolveAutoApprove(cwd)).toBe(true);
  });
});
