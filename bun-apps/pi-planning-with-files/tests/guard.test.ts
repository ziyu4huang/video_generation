import { describe, expect, it } from "bun:test";
import { isDangerousBashCommand } from "../src/guard.js";

describe("isDangerousBashCommand", () => {
  const dangerous = [
    "rm -rf /",
    "rm -Rf build",
    "sudo apt install x",
    "chmod 777 .",
    "chmod a+rwx secrets",
    "git push --force origin main",
    "git push -f origin main",
    "git push --mirror",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    ":(){ :|:& };:",
    "dd if=/dev/zero of=/dev/sda",
  ];

  const safe = [
    "ls -la",
    "git push origin feature/draft-notification",
    "git push origin main",
    "rm file.txt",
    "chmod 644 file.txt",
    "git status",
    "cat README.md",
  ];

  for (const cmd of dangerous) {
    it(`flags destructive: ${cmd}`, () => {
      expect(isDangerousBashCommand(cmd)).toBe(true);
    });
  }

  for (const cmd of safe) {
    it(`allows benign: ${cmd}`, () => {
      expect(isDangerousBashCommand(cmd)).toBe(false);
    });
  }

  it("does NOT flag a normal push (word-boundary discipline)", () => {
    expect(isDangerousBashCommand("git push origin my-feature")).toBe(false);
  });

  it("is a substring guard: it flags 'rm -rf' even inside echo (known false-positive by design)", () => {
    // The upstream guard pattern-matches the command string without context
    // awareness, so 'echo rm -rf' trips it. This is intentional v2.40 behavior —
    // a warning, never a hard block — preserved faithfully from upstream.
    expect(isDangerousBashCommand("echo rm -rf")).toBe(true);
  });

  it("requires r-before-f: 'rm -fr' (f-before-r) is NOT caught (upstream regex gap, preserved)", () => {
    // The regex -[a-z]*r[a-z]*f matches '-rf'/'-Rf' but not '-fr'. Preserved as-is.
    expect(isDangerousBashCommand("rm -fr build")).toBe(false);
  });
});
