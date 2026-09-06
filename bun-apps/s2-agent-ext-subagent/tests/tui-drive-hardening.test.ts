/**
 * tui-drive-hardening.test.ts — source-pin guards for the pty driver's
 * hard-won emulation lessons (agents-manager t03 loop findings + the four
 * boot gotchas). The driver is the self-evolve loop's vehicle; every lesson
 * below was found LIVE by a failing receipt. If a refactor drops one of
 * these lines, the driver silently degrades — receipts pass vacuously or the
 * screen never renders — and ONLY these pins catch it, because the failure
 * modes are all "no error, wrong behavior".
 *
 * Pin style follows agent-registry-seam-wiring.test.ts: read the script
 * source, assert the load-bearing line exists and sits where it matters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "scripts", "tui-drive.ts"), "utf8");

describe("tui-drive pty gotchas (source pins)", () => {
  test("坑1 — forces TERM=xterm-256color (inherited TERM=dumb silently kills the TUI render)", () => {
    expect(src).toContain('TERM: "xterm-256color"');
  });

  test("坑2 — feeds xterm-headless in 64-byte awaited chunks (a large single write stalls its WriteBuffer)", () => {
    expect(src).toContain("i += 64");
    expect(src).toContain("await new Promise<void>((res) => term.write(c, () => res()))");
  });

  test("坑3 — answers primary DA with the xterm reply and stays SILENT on kitty (legacy key encoding)", () => {
    expect(src).toContain('tty.write("\\x1b[?1;2c")');
    // The kitty silence is deliberate — pin the comment so a "helpful" reply
    // doesn't get added (answering commits us to CSI-u key output).
    expect(src).toContain("kitty");
    expect(src).toContain("intentionally unanswered");
  });

  test("坑4 — settle heuristic is live markers only (transcript text never disappears)", () => {
    expect(src).toContain("/Working\\.\\.\\.|esc to interrupt|");
  });
});

describe("tui-drive loop-finding fixes (source pins)", () => {
  test("F1/坑5 — fresh-dialog key retries use real sleeps + a screen state-guard", () => {
    // waitIdle returns instantly on a static dialog (no bytes = already
    // quiet); pacing must be wall-clock, and Enter may only fire while the
    // list footer is showing.
    expect(src).toContain("await sleep(700)");
    expect(src).toContain('/enter detail/.test(screen().join("\\n"))');
  });

  test("model policy — scenarios seed the hard-problem agentType (zai/glm-5.3) into the scratch project", () => {
    expect(src).toContain("hard-problem");
    expect(src).toContain("model: zai/glm-5.3");
  });

  test("model policy — the dispatch prompt routes through agentType, not a bare spawn", () => {
    expect(src).toContain("agentType set to hard-problem");
  });

  test("model policy — receipts assert the child ran glm-5.3, not flash (childModelIsGlm53)", () => {
    expect(src).toContain("childModelIsGlm53");
    // The check must exclude flash by name: "glm-5.3" is a substring of
    // "glm-5.3-flash", so a bare includes() would pass on a flash child. The
    // parent's status bar is excluded structurally (row-marker prefix).
    expect(src).toContain('!t.includes("flash")');
    expect(src).toContain("/^(Task\\(|Task:|\\[\\d+\\]|bg\\b|▶)/");
  });
});
