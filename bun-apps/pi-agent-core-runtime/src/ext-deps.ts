/**
 * ext-deps.ts — "is this extension's dependency actually available?", answered
 * the same way in every mode pi-agent runs in.
 *
 * WHY THIS EXISTS
 * ---------------
 * An extension asks this once at session_start so that a developer who forgot
 * `bun install` gets "run bun install" instead of a stack trace from the first
 * import. Two extensions (obsidian, file2md) each carried their own copy of the
 * probe, and both copies asked the wrong question: they walked the real
 * filesystem upward looking for `node_modules/<pkg>`. That is a question about
 * LAYOUT, not about availability, so every mode that does not use node_modules
 * had to be special-cased by sniffing the path string — and only ONE such mode
 * ever was. `bun build --compile` got its `$bunfs` special case; the sh deploy
 * did not. A deployed extension's dir is a perfectly ordinary path under
 * `<outRoot>/<version>/ext/<name>/` with no node_modules above it, so the probe
 * declared every host-provided dependency missing. #1738 put obsidian into the
 * sh base set and the false alarm became a red error on every single start.
 *
 * THE RULE
 * --------
 * Only source mode can be missing an install, so only source mode is probed.
 * The other two modes are recognised POSITIVELY — by an artifact their build
 * wrote — never by guessing at the shape of a path:
 *
 *   - compiled binary → `import.meta.dir` is Bun's virtual-fs scheme. Deps are
 *     inlined into the binary at build time; there is nothing on disk to find.
 *   - sh deploy       → the extension dir contains the `ext.json` the deploy
 *     wrote. Every dependency is then either bundled into `ext.cjs` or served
 *     by the host's injected `require`, and `ext-build` already FAILED the
 *     build for any specifier that is neither. The question is settled before
 *     the tree ships; re-asking it at runtime can only produce false alarms.
 *   - source          → node_modules is genuinely the answer. Probe it.
 *
 * Keep this the only implementation. `extension-dep-probe.test.ts` in pi-agent
 * fails the build if an extension grows a private copy again.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * True for Bun's compiled-binary virtual filesystem scheme, in all three
 * spellings bun has used ($bunfs, ~BUN, and the URL-encoded %7EBUN).
 */
export function isBunVirtualPath(path: string): boolean {
  return path.includes("$bunfs") || path.includes("~BUN") || path.includes("%7EBUN");
}

/** `@scope/name/deep` → `@scope/name`; `name/deep` → `name`. */
export function packageBaseName(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0] ?? spec;
}

/**
 * True when `dir` is an extension directory inside a pi-agent-sh deploy.
 *
 * The signature is `ext.json` carrying a numeric `hostApi` — the manifest the
 * deploy writes and the loader validates. Presence alone would be a weaker
 * signal (a source tree could hold a file of that name for another purpose);
 * requiring the host-contract field makes a false positive require someone to
 * hand-forge the deploy's own manifest.
 */
export function isDeployedExtDir(dir: string): boolean {
  const manifest = join(dir, "ext.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { hostApi?: unknown };
    return typeof parsed.hostApi === "number";
  } catch {
    return false;
  }
}

/**
 * Which of `deps` an extension loaded from `from` cannot resolve.
 *
 * `from` is the extension's own directory (`import.meta.dir`, or whatever the
 * deploy's `#pi/ext-dir` channel returned). `undefined` means the caller could
 * not determine it — report nothing rather than guess.
 */
export function missingExtDeps(deps: string[], from: string | undefined): string[] {
  if (!from) return [];
  if (isBunVirtualPath(from)) return [];
  if (isDeployedExtDir(from)) return [];
  return deps.filter((dep) => {
    const pkg = packageBaseName(dep);
    let dir = from;
    for (;;) {
      if (existsSync(join(dir, "node_modules", pkg, "package.json"))) return false;
      const parent = dirname(dir);
      if (parent === dir) return true;
      dir = parent;
    }
  });
}

/**
 * The workspace root above `from`, for the "run bun install (in X)" hint.
 * Falls back to the literal "(repo root)" when there is nothing to point at —
 * which is itself a signal that the caller is not in a source checkout.
 */
export function findWorkspaceRoot(from: string | undefined): string {
  if (!from) return "(repo root)";
  let dir = from;
  while (dir !== dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        workspaces?: unknown;
      };
      if (pkg.workspaces) return dir;
    } catch {
      /* no package.json here, or unreadable — keep walking up */
    }
    dir = dirname(dir);
  }
  return "(repo root)";
}
