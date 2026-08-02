import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to a bundled procedure file under `<pkg>/procedures/`.
 *
 * Uses `import.meta.url` so the path is correct whether the extension runs from
 * `src/` (jiti / dev) or `dist/` (built), and regardless of where the package is
 * installed. Procedures live OUTSIDE `skills/` on purpose: pi auto-registers
 * every `skills/` entry as a user-invocable `/skill:<name>` slash command, which
 * duplicates the `/wayfind` command. Moving the wayfinder procedure here keeps it
 * loadable on demand by the command that needs it, without surfacing a redundant
 * slash entry. See `commands.ts` (handleWayfinderChart) for the call site.
 */
export function procedurePath(name: string): string {
  // procedures.ts is at <pkg>/src/procedures.ts → procedures/ is ../procedures/
  return fileURLToPath(new URL(`../procedures/${name}.md`, import.meta.url));
}
