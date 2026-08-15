/**
 * paths.ts — path-safety + argv-injection guards for the ltx-video tool.
 *
 * The agent supplies image/video/model paths and (via extraArgs) raw flag
 * tokens. Both are attacker-controllable from the model's perspective: a path
 * that resolves outside an allowed root, or a token that starts with "-", can
 * hijack the ltx-video invocation (e.g. overwrite an arbitrary file). Mirrors
 * pi-agent-ext-flux2/src/paths.ts's guarantees exactly (same threat model,
 * same repo conventions) — see that file's header for the underlying
 * memories this design traces back to.
 *
 * Guarantees enforced here:
 *   • every image/video/model path resolves UNDER an allowed root;
 *   • any string value beginning with "-" is rejected (never reaches the arg list);
 *   • extraArgs tokens are split: leading-dash tokens must match an allow-listed
 *     flag prefix, value tokens are path-validated.
 */
import { basename, dirname, isAbsolute, join, resolve as pResolve, sep } from "node:path";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSafetyError";
  }
}

/** Allowed roots: repo root + the MLX output dir + the models tree. */
export interface AllowedRoots {
  repoRoot: string;
  outputDir: string;
  modelsRoot: string;
}

function under(child: string, root: string): boolean {
  // Normalize so a root that already ends with the separator (notably "/"
  // itself, the filesystem root) doesn't get doubled into "//" — which would
  // never match any real child path and wrongly reject everything under it.
  const c = child.endsWith(sep) ? child : child + sep;
  const r = root.endsWith(sep) ? root : root + sep;
  return c === r || c.startsWith(r);
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function realpathOfNearestExisting(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  const resolvedBase = realOrSelf(cur);
  return tail.length ? join(resolvedBase, ...tail) : resolvedBase;
}

/**
 * Validate that `p` resolves to a path under one of the allowed roots.
 * Returns the resolved absolute path. Throws PathSafetyError otherwise.
 * Rejects leading-dash values (would inject a CLI flag) before resolving.
 *
 * `mustExist=false` allows validating an OUTPUT path that does not exist yet.
 */
export function assertPathAllowed(
  raw: string,
  roots: AllowedRoots,
  opts: { mustExist?: boolean; kind?: string } = {},
): string {
  const kind = opts.kind ?? "path";
  if (typeof raw !== "string" || raw.length === 0) {
    throw new PathSafetyError(`${kind}: empty value`);
  }
  if (raw.startsWith("-")) {
    throw new PathSafetyError(`${kind}: value "${raw}" looks like a flag (leading '-'), refusing to pass to ltx-video`);
  }
  const abs = isAbsolute(raw) ? raw : pResolve(roots.repoRoot, raw);
  const real = realpathOfNearestExisting(abs);

  const allowed = [roots.repoRoot, roots.outputDir, roots.modelsRoot];
  const ok = allowed.some((root) => under(real, realOrSelf(root)));
  if (!ok) {
    throw new PathSafetyError(
      `${kind}: "${raw}" (→ ${abs}) is outside allowed roots:\n  ` +
        allowed.map((r) => `• ${r}`).join("\n  "),
    );
  }

  if (opts.mustExist && !existsSync(real)) {
    throw new PathSafetyError(`${kind}: "${raw}" (→ ${abs}) does not exist`);
  }
  return abs;
}

/** Reject any value beginning with "-" (flag-injection guard for free-form fields). */
export function rejectFlagLike(value: string, kind: string): void {
  if (typeof value === "string" && value.startsWith("-")) {
    throw new PathSafetyError(
      `${kind}: value "${value}" looks like a flag (leading '-'), refusing to pass to ltx-video`,
    );
  }
}

/**
 * Validate that `value` is a bare path COMPONENT (a transformer/vae/model
 * variant name the Swift binary joins onto a models-tree root itself, e.g.
 * `--t2i-transformer <value>` -> `RepoPaths.mlxModelsRoot/transformer/<value>`),
 * NOT a path this tool resolves. Same rationale as
 * pi-agent-ext-flux2/src/paths.ts's assertSafePathComponent.
 */
export function assertSafePathComponent(value: string, kind: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new PathSafetyError(`${kind}: empty value`);
  }
  rejectFlagLike(value, kind);
  const segments = value.split(/[\\/]/);
  if (segments.length > 1 || segments[0] === "." || segments[0] === "..") {
    throw new PathSafetyError(
      `${kind}: value "${value}" must be a bare name (no path separators or ".." segments), not a path`,
    );
  }
}

/**
 * Strip a trailing ":<float>" strength suffix (e.g. a "--lora path:0.8" spec)
 * before path-validating, mirroring index.ts's pathSpecFieldKeys handling —
 * without this, the exists-check silently validates the wrong (suffixed)
 * string instead of the real path portion.
 */
function stripStrengthSuffix(raw: string): string {
  const m = raw.match(/^(.*):-?\d+(?:\.\d+)?$/);
  return m ? m[1]! : raw;
}

/**
 * Validate a single extraArgs VALUE (never a flag) against `roots`. Every
 * non-flag token is checked, not just ones that "look like" a path
 * (relative scalars like "42"/"fast" resolve harmlessly under repoRoot and
 * pass; the check is what catches an absolute or ".."-escaping value).
 */
function validateExtraArgValue(value: string, roots: AllowedRoots, kind: string): void {
  assertPathAllowed(stripStrengthSuffix(value), roots, { kind });
}

/**
 * Validate a list of raw extraArgs tokens the agent may pass as an escape hatch.
 * Leading-dash tokens must match an allow-listed flag prefix; value tokens are
 * path-validated against `roots`. Returns the cleaned token list.
 */
export function validateExtraArgs(
  tokens: string[],
  roots: AllowedRoots,
  allowedFlagPrefixes: string[],
): string[] {
  const out: string[] = [];
  const prefixSet = new Set(allowedFlagPrefixes);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (typeof tok !== "string" || tok.length === 0) continue;
    if (tok.startsWith("-")) {
      const stripped = tok.replace(/^-+/, "");
      const eqIdx = stripped.indexOf("=");
      const flagName = eqIdx >= 0 ? stripped.slice(0, eqIdx) : stripped;
      if (!prefixSet.has(flagName)) {
        throw new PathSafetyError(
          `extraArgs: flag "${tok}" is not allow-listed. Allowed: ${[...prefixSet].sort().join(", ")}`,
        );
      }
      // "--flag=value" syntax (swift-argument-parser accepts this for any
      // Option): the value half must be validated exactly like a standalone
      // value token below — otherwise it reaches argv completely unchecked.
      if (eqIdx >= 0) {
        validateExtraArgValue(stripped.slice(eqIdx + 1), roots, `extraArgs value (${flagName}=)`);
      }
      out.push(tok);
    } else {
      validateExtraArgValue(tok, roots, "extraArgs value");
      out.push(tok);
    }
  }
  return out;
}

/**
 * Guard an agent-supplied `outputDir`/`modelsRoot` OVERRIDE itself, before it
 * is admitted into AllowedRoots and starts being trusted as a sandbox
 * boundary for every other path field. Without this, an agent could set
 * `outputDir: "/etc"` (or any directory) and the "every path must resolve
 * under an allowed root" guarantee becomes circular — the override IS the
 * allowed root, so nothing is actually rejected (found by
 * pi-agent-ext-ltx-self-improve's review lane, 2026-07-05). Allowed to be
 * ANYWHERE under repoRoot's PARENT directory — this still covers the
 * repo's own sibling-directory convention (`../video_generation__output`,
 * `../video_generation__models`, both external stores per CLAUDE.md) and
 * any path under the repo itself, while rejecting an override that escapes
 * to an unrelated part of the filesystem.
 */
function assertOverrideRootAllowed(overrideAbs: string, repoRoot: string, kind: string): void {
  const real = realpathOfNearestExisting(overrideAbs);
  const parent = dirname(repoRoot);
  if (!under(real, realOrSelf(repoRoot)) && !under(real, realOrSelf(parent))) {
    throw new PathSafetyError(
      `${kind} override "${overrideAbs}" is outside the allowed sandbox — must resolve under the repo root ` +
        `(${repoRoot}) or its parent directory (${parent}), not an arbitrary location.`,
    );
  }
}

/** Resolve the default MLX output dir, mirroring run.py / pi-agent-ext-flux2's own resolution. */
export function resolveOutputDir(repoRoot: string, override?: string): string {
  if (override && override.length > 0) {
    rejectFlagLike(override, "outputDir");
    const abs = isAbsolute(override) ? override : pResolve(repoRoot, override);
    assertOverrideRootAllowed(abs, repoRoot, "outputDir");
    return abs;
  }
  if (process.env.MLX_OUTPUT_DIR) return pResolve(process.env.MLX_OUTPUT_DIR);
  return pResolve(repoRoot, "..", "video_generation__output");
}

/**
 * Resolve the output dir and guarantee it exists (write target). Mirrors
 * pi-agent-ext-flux2's create-if-missing philosophy. Returns the resolved
 * absolute path.
 */
export function ensureOutputDir(repoRoot: string, override?: string): string {
  const dir = resolveOutputDir(repoRoot, override);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the models root, mirroring RepoPaths.mlxModelsRoot / $MLX_MODELS_DIR. */
export function resolveModelsRoot(repoRoot: string, override?: string): string {
  if (override && override.length > 0) {
    rejectFlagLike(override, "modelsRoot");
    const abs = isAbsolute(override) ? override : pResolve(repoRoot, override);
    assertOverrideRootAllowed(abs, repoRoot, "modelsRoot");
    return abs;
  }
  if (process.env.MLX_MODELS_DIR) return pResolve(process.env.MLX_MODELS_DIR);
  return pResolve(repoRoot, "mlx-models");
}

/**
 * Assert the models root exists (read target). ltx-video has no
 * --models-root CLI flag (unlike flux2) — RepoPaths.mlxModelsRoot is baked
 * in at build time — so this only gates our OWN path-safety checks and
 * gives an actionable error before spawning the binary; it does not get
 * injected as an argv flag (see index.ts's buildArgv).
 */
export function assertModelsRootExists(repoRoot: string, override?: string): string {
  const dir = resolveModelsRoot(repoRoot, override);
  if (!existsSync(dir)) {
    throw new PathSafetyError(
      `Models dir not found: ${dir}\n` +
        "Set MLX_MODELS_DIR, or place the MLX model tree at <repo>/mlx-models.",
    );
  }
  return dir;
}

/** stat helper, symlink-aware. */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
