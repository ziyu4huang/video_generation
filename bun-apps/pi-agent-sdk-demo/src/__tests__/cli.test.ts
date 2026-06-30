import { test, expect, describe } from "bun:test";
import { resolve, findChild, parseChatFlags, ROOT } from "../cli.ts";

describe("findChild", () => {
  test("matches by name", () => {
    const node = findChild(ROOT, "config");
    expect(node?.name).toBe("config");
  });

  test("returns undefined for unknown token", () => {
    expect(findChild(ROOT, "nope")).toBeUndefined();
  });

  test("descends one level", () => {
    const config = findChild(ROOT, "config");
    const models = findChild(config!, "models");
    expect(models?.name).toBe("models");
  });
});

describe("resolve", () => {
  test("routes a top-level leaf", () => {
    const { node, path, args } = resolve(["minimal", "List", "files"]);
    expect(node.name).toBe("minimal");
    expect(path).toEqual(["minimal"]);
    expect(args).toEqual(["List", "files"]);
  });

  test("routes a nested command (config models)", () => {
    const { node, path, args } = resolve(["config", "models"]);
    expect(node.name).toBe("models");
    expect(path).toEqual(["config", "models"]);
    expect(args).toEqual([]);
  });

  test("stops walking at the first flag token", () => {
    const { node, path, args } = resolve(["chat", "-p", "--new", "hi"]);
    expect(node.name).toBe("chat");
    expect(path).toEqual(["chat"]);
    expect(args).toEqual(["-p", "--new", "hi"]);
  });

  test("stops walking at the first unknown token", () => {
    const { node, path, args } = resolve(["chat", "bogus-sub", "-p"]);
    expect(node.name).toBe("chat");
    expect(path).toEqual(["chat"]);
    // "bogus-sub" is not a known child of chat → leftover arg.
    expect(args).toEqual(["bogus-sub", "-p"]);
  });

  test("returns ROOT when nothing matches", () => {
    const { node, path, args } = resolve(["totally-unknown"]);
    expect(node).toBe(ROOT);
    expect(path).toEqual([]);
    expect(args).toEqual(["totally-unknown"]);
  });

  test("empty argv returns ROOT with no path", () => {
    const { node, path, args } = resolve([]);
    expect(node).toBe(ROOT);
    expect(path).toEqual([]);
    expect(args).toEqual([]);
  });

  test("version command is registered", () => {
    const { node, path } = resolve(["version"]);
    expect(node.name).toBe("version");
    expect(path).toEqual(["version"]);
  });
});

describe("parseChatFlags", () => {
  test("defaults: no flags → empty object", () => {
    expect(parseChatFlags([])).toEqual({});
  });

  test("--new / --resume booleans", () => {
    expect(parseChatFlags(["--new"]).new).toBe(true);
    expect(parseChatFlags(["--resume"]).resume).toBe(true);
    expect(parseChatFlags(["-r"]).resume).toBe(true);
  });

  test("-p / --print", () => {
    expect(parseChatFlags(["-p", "hi"]).print).toBe(true);
    expect(parseChatFlags(["--print", "hi"]).print).toBe(true);
  });

  test("positional args join into prompt", () => {
    const out = parseChatFlags(["summarize", "this", "now"]);
    expect(out.prompt).toBe("summarize this now");
  });

  test("--tools list (space and = forms)", () => {
    expect(parseChatFlags(["--tools", "read,grep"]).tools).toEqual(["read", "grep"]);
    expect(parseChatFlags(["--tools=read,grep , bash "]).tools).toEqual([
      "read",
      "grep",
      "bash",
    ]);
  });

  test("--idle-timeout parses seconds → ms (space and = forms)", () => {
    expect(parseChatFlags(["--idle-timeout", "20"]).idleTimeoutMs).toBe(20000);
    expect(parseChatFlags(["--idle-timeout=5"]).idleTimeoutMs).toBe(5000);
  });

  test("--no-idle-timeout sets ms to 0", () => {
    expect(parseChatFlags(["--no-idle-timeout"]).idleTimeoutMs).toBe(0);
  });

  test("--session / -s (space and = forms)", () => {
    expect(parseChatFlags(["--session", "abc"]).sessionId).toBe("abc");
    expect(parseChatFlags(["-s", "abc"]).sessionId).toBe("abc");
    expect(parseChatFlags(["--session=xyz"]).sessionId).toBe("xyz");
  });

  test("--mode json enables jsonMode", () => {
    expect(parseChatFlags(["--mode", "json"]).jsonMode).toBe(true);
    expect(parseChatFlags(["--mode=json"]).jsonMode).toBe(true);
  });

  test("--mode other value does NOT enable jsonMode", () => {
    expect(parseChatFlags(["--mode", "text"]).jsonMode).toBeUndefined();
  });

  test("--no-session", () => {
    expect(parseChatFlags(["--no-session"]).noSession).toBe(true);
  });

  test("--append-system-prompt (space and = forms)", () => {
    expect(parseChatFlags(["--append-system-prompt", "sp.md"]).appendSystemPrompt).toBe(
      "sp.md",
    );
    expect(parseChatFlags(["--append-system-prompt=sp.md"]).appendSystemPrompt).toBe(
      "sp.md",
    );
  });

  test("--list", () => {
    expect(parseChatFlags(["--list"]).list).toBe(true);
  });

  test("unknown flags are dropped from positional prompt", () => {
    const out = parseChatFlags(["-x", "real", "--unknown=y", "prompt"]);
    expect(out.prompt).toBe("real prompt");
  });
});
