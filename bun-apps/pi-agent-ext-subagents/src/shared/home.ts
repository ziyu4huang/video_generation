import { homedir } from "node:os";

/**
 * Resolve the user home directory, honoring `$HOME` first.
 *
 * On Unix production `process.env.HOME` is set and equals `os.homedir()`, so this
 * is a no-op there. It matters for tests (tests set `$HOME` to a temp directory):
 * Bun's `os.homedir()` ignores `process.env.HOME` at runtime (unlike Node), so
 * callers that need the override must read the env directly rather than calling
 * `homedir()`.
 *
 * Note: This repo has a sibling utility at pi-agent-ext-workflow/src/home.ts with
 * identical logic. If you change one, update the other.
 */
export function homeDir(): string {
  return process.env.HOME || homedir();
}
