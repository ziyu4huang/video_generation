import { homedir } from "node:os";

/**
 * Resolve the user home directory, honoring `$HOME` first.
 *
 * On Unix production `process.env.HOME` is set and equals `os.homedir()`, so this
 * is a no-op there. It matters for tests (`tests/helpers/fake-home.ts` redirects
 * home by setting `$HOME`): Bun's `os.homedir()` ignores `process.env.HOME` at
 * runtime (unlike Node), so callers that need the override must read the env
 * directly rather than calling `homedir()`.
 */
export function homeDir(): string {
  return process.env.HOME || homedir();
}
