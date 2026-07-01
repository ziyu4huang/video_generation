/**
 * resolve.ts — resolves this repo's fixed extension/skill set to ABSOLUTE paths,
 * independent of process.cwd(). This is what makes pi-agent "deploy to any path":
 * the vendored pi-coding-agent has no --cwd flag and threads process.cwd() into
 * every project-resource lookup (.pi/settings.json, .pi/extensions, etc.), so the
 * only cwd-independent hook it exposes is passing already-absolute paths via
 * -e/--skill CLI flags (resolvePath() returns absolute inputs unchanged, and
 * these paths are never trust-gated). See run-dir/manifest.json for the source
 * list and bun-apps/pi-agent/README.md for the full rationale.
 *
 * MODE DETECTION (same problem/pattern as src/patches/set-package-dir.ts):
 * Bun's bundler rewrites import.meta.url/import.meta.dir to the bundle output
 * location, so "resolve(import.meta.dir, '..', '..')" only computes the real
 * bun-apps/ dir in source mode. In bundle mode we load build-time-baked
 * absolute paths from src/generated/run-dir-base.ts (gitignored), written by
 * scripts/build.ts's stageGenerateRunDirBase().
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.json";

// Fixed npm-sourced extensions (migrated off the old isolated .pi/npm/ tree —
// now plain `dependencies` in package.json, resolved via the shared node_modules
// tree). Relative entry points come from each package's own "pi".extensions field.
//
// NOTE: @juicesharp/rpiv-todo is intentionally NOT baked in here. This user's
// personal ~/.pi/agent/settings.json already declares it as a global-scope
// package (loads for every pi invocation regardless of cwd), so it behaves
// like the "personal data" that's meant to stay at ~/.pi/ per the run-dir
// migration's goal, not like a project-specific extension. Baking a second
// copy here causes a "Tool \"todo\" conflicts" crash against the user's own
// global-scope load — verified during the source-mode cwd-independence test.
const NPM_EXTENSIONS: Array<{ pkg: string; entry: string }> = [
  { pkg: "@juicesharp/rpiv-ask-user-question", entry: "index.ts" },
  { pkg: "pi-hermes-memory", entry: "src/index.ts" },
];

const url = import.meta.url;
const isBinary = url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
const isSource = url.includes("/run-dir/");

function warn(msg: string) {
  console.error(`[bun-pi] run-dir: ${msg}`);
}

async function resolveBunAppsDir(): Promise<string | undefined> {
  if (!isBinary && !isSource) {
    // Bundle mode: only the build-time-generated constant is reliable.
    try {
      // @ts-ignore — generated at build time; absent in a clean source tree
      const mod = await import("../src/generated/run-dir-base.ts");
      return mod.BUN_APPS_DIR || undefined;
    } catch {
      return undefined;
    }
  }
  // Source mode: run-dir/resolve.ts -> pi-agent/ -> bun-apps/
  return resolve(dirname(fileURLToPath(url)), "..", "..");
}

async function resolveNpmExtensionPaths(): Promise<string[]> {
  if (!isBinary && !isSource) {
    try {
      // @ts-ignore — generated at build time; absent in a clean source tree
      const mod = await import("../src/generated/run-dir-base.ts");
      return (mod.NPM_EXTENSION_PATHS as string[] | undefined) ?? [];
    } catch {
      return [];
    }
  }
  const paths: string[] = [];
  for (const { pkg, entry } of NPM_EXTENSIONS) {
    try {
      const pkgJsonUrl = import.meta.resolve(`${pkg}/package.json`);
      const pkgDir = dirname(fileURLToPath(pkgJsonUrl));
      paths.push(join(pkgDir, entry));
    } catch {
      warn(`could not resolve npm package "${pkg}" — skipping (run \`bun install\` at repo root?)`);
    }
  }
  return paths;
}

/** Returns a flat argv fragment: ["-e", absPath, ..., "--skill", absPath, ...] */
export async function resolveRunDirArgv(): Promise<string[]> {
  // Compiled-binary mode: no-op. pi can't load .ts extensions here anyway
  // (jiti feeds each extension as a base64 data: URL → Bun ENAMETOOLONG — see
  // README "Build modes"), and import.meta.url is the $bunfs virtual scheme so
  // the absolute-path resolution below yields garbage (e.g. BUN_APPS_DIR
  // collapsing to "/", producing "/zai-mcp/…" non-paths). Without this guard
  // every binary invocation — even --version — spews ~7 "skipping" warnings.
  // The bundled .js (not the --compile binary) is the supported shipped path.
  if (isBinary) {
    if (process.env.BUN_PI_DEBUG_RUN_DIR === "1") {
      warn("compiled-binary mode — extensions can't load here; returning no argv");
    }
    return [];
  }
  const bunAppsDir = await resolveBunAppsDir();
  const argv: string[] = [];

  const extensionPaths: string[] = [];
  if (bunAppsDir) {
    for (const rel of manifest.extensions ?? []) {
      extensionPaths.push(join(bunAppsDir, rel));
    }
  } else {
    warn("could not determine bun-apps/ directory — skipping workspace-local extensions");
  }
  extensionPaths.push(...(await resolveNpmExtensionPaths()));

  for (const p of extensionPaths) {
    if (existsSync(p)) {
      argv.push("-e", p);
    } else {
      warn(`extension path not found, skipping: ${p}`);
    }
  }

  if (bunAppsDir) {
    for (const rel of manifest.skills ?? []) {
      const p = join(bunAppsDir, rel);
      if (existsSync(p)) {
        argv.push("--skill", p);
      } else {
        warn(`skill path not found, skipping: ${p}`);
      }
    }
  }

  return argv;
}
