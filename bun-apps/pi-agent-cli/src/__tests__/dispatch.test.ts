import { test, expect, describe } from "bun:test";
import { findCommandToken } from "../cli.ts";

/**
 * Guards the regression where a global flag placed BEFORE the sub-command
 * (e.g. `--model X vlm-describe file.pdf`) caused `vlm-describe` to be fed to
 * the agent as a prompt (passthrough) instead of dispatching the command.
 *
 * The command token must be resolved as the first POSITIONAL, skipping value
 * flags and their values; leading global flags must be preserved (reflected by
 * the returned index, which lets the caller strip only the command token).
 */
describe("findCommandToken — global flags before sub-command", () => {
  test("regression: --model <value> before command is detected", () => {
    const argv = [
      "--model", "lm-studio/google/gemma-4-26b-a4b-qat",
      "vlm-describe", "fixture/p.pdf",
      "--out", "./tmp/x/", "--pages", "16",
    ];
    expect(findCommandToken(argv)).toEqual({ name: "vlm-describe", index: 2 });
  });

  test("command-first (no leading flags) still works (backward compat)", () => {
    const argv = ["vlm-describe", "fixture/p.pdf", "--pages", "16"];
    expect(findCommandToken(argv)).toEqual({ name: "vlm-describe", index: 0 });
  });

  test("multiple value-flags before command are all skipped", () => {
    const argv = ["--provider", "zai", "--model", "glm-5.2", "zk-ask", "question?"];
    expect(findCommandToken(argv)).toEqual({ name: "zk-ask", index: 4 });
  });

  test("= form value-flags before command are skipped", () => {
    // `--model=x` and `--pages=1` are each a single token, so the command lands
    // at index 2 (not 3 — the `=` form does not consume a separate value token).
    const argv = ["--model=x", "--pages=1", "vlm-describe", "p.pdf"];
    expect(findCommandToken(argv)).toEqual({ name: "vlm-describe", index: 2 });
  });

  test("meta commands are detected after global flags", () => {
    expect(findCommandToken(["--model", "x", "list"])).toEqual({ name: "list", index: 2 });
    expect(findCommandToken(["--model", "x", "version"])).toEqual({ name: "version", index: 2 });
    // NOTE: bare `help` is consumed by parsePiArgs as the --help flag (not a
    // positional), so findCommandToken returns undefined here. main() still
    // surfaces it via the passthrough path's `parsed.help` guard.
    expect(findCommandToken(["--model", "x", "help"])).toBeUndefined();
  });

  test("pipeline namespace is detected after global flags", () => {
    const argv = ["--model", "x", "pipeline", "pdf-to-vault", "p.pdf"];
    expect(findCommandToken(argv)).toEqual({ name: "pipeline", index: 2 });
  });

  test("passthrough-only (no positional) → undefined", () => {
    expect(findCommandToken(["--model", "x", "-p", "--no-session"])).toBeUndefined();
  });

  test("passthrough prompt that is not a command → undefined", () => {
    expect(findCommandToken(["--model", "x", "summarize this file"])).toBeUndefined();
  });

  test("reserved word only counts as command when it is the FIRST positional", () => {
    // `-p "vlm-describe"` → "vlm-describe" is the first positional and reserved,
    // so it dispatches as a command (not a prompt). This is intentional.
    expect(findCommandToken(["-p", "vlm-describe"])).toEqual({ name: "vlm-describe", index: 1 });
    // But a reserved word appearing AFTER a non-command positional is a prompt,
    // not a command — only the first positional is considered.
    expect(findCommandToken(["some prompt", "vlm-describe"])).toBeUndefined();
  });

  test("oneshot backward-compat alias: stripped by caller, not here", () => {
    // findCommandToken operates on already-stripped argv; the oneshot alias is
    // handled in main(). A bare leading command still resolves.
    expect(findCommandToken(["vlm-describe", "p.pdf"])).toEqual({ name: "vlm-describe", index: 0 });
  });
});
