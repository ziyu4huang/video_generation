/**
 * paths.ts — path-safety + argv-injection guards for the flux2 tool.
 *
 * The agent supplies image/model paths and (via extraArgs) raw flag tokens.
 * Both are attacker-controllable from the model's perspective: a path that
 * resolves outside an allowed root, or a token that starts with "-", can
 * hijack the flux2 invocation (e.g. overwrite an arbitrary file, or inject
 * `--output /etc/x`). See memory [[argv-injection-positional-paths]] and
 * [[output-dir-externalized-unified]].
 *
 * Guarantees enforced here:
 *   • every image/model path resolves UNDER an allowed root;
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
  const c = child + sep;
  const r = root + sep;
  return c === r || c.startsWith(r);
}

/**
 * Resolve `p` through any symlinks; falls back to `p` unchanged if it doesn't
 * exist or realpath fails. Roots themselves can be symlinks (e.g. macOS
 * tmpdir: /var/folders/... -> /private/var/folders/...) — comparing an
 * unresolved root against a resolved child path would otherwise reject every
 * legitimate path under such a root.
 */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve `p` through symlinks as far as possible even when `p` itself does
 * not exist yet (e.g. an output file about to be written): walk up to the
 * nearest EXISTING ancestor, realpath that, then re-append the non-existent
 * tail. Without this, a not-yet-created path under a symlinked root (macOS
 * tmpdir: /var/... -> /private/var/...) would compare an unresolved child
 * against a resolved root and be wrongly rejected.
 */
function realpathOfNearestExisting(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root without finding an existing ancestor
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
    throw new PathSafetyError(`${kind}: value "${raw}" looks like a flag (leading '-'), refusing to pass to flux2`);
  }
  const abs = isAbsolute(raw) ? raw : pResolve(roots.repoRoot, raw);

  // Follow symlinks (including on non-existent paths, via the nearest
  // existing ancestor) so symlinked model stores AND symlinked roots resolve.
  const real = realpathOfNearestExisting(abs);

  // Require the RESOLVED (post-symlink) path to be confined. Checking `abs` as
  // an OR-alternative let a symlink staged inside an allowed root (e.g. a
  // writable outputDir) point anywhere on disk and still validate — `real`
  // falls back to `abs` above when the target doesn't exist, so this is not
  // weaker for the common not-yet-created-output case.
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
      `${kind}: value "${value}" looks like a flag (leading '-'), refusing to pass to flux2`,
    );
  }
}

/**
 * Validate that `value` is a bare path COMPONENT (a model/variant/LoRA name
 * the Swift binary joins onto a models-tree root itself via a raw
 * appendingPathComponent, e.g. `--transformer <value>` ->
 * `ModelPaths.transformerRoot.appendingPathComponent(value)`), NOT a path
 * this tool resolves. The Swift side does that join with NO ".."-sanitization
 * (verified against ModelPaths/T2ICommand/SceneCommand/EditCommand/etc. and
 * Flux2LoRA.swift), so a value containing a path separator or a ".." segment
 * would let the Swift binary read model weights from outside the intended
 * models tree entirely — assertPathAllowed's "resolve under an allowed root"
 * check does not apply here since the agent never supplies a full path for
 * these fields.
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
      // Strip any leading "--" or "-" and "=value" suffix to test the flag name.
      const stripped = tok.replace(/^-+/, "");
      const flagName = stripped.split("=")[0] ?? "";
      if (!prefixSet.has(flagName)) {
        throw new PathSafetyError(
          `extraArgs: flag "${tok}" is not allow-listed. Allowed: ${[...prefixSet].sort().join(", ")}`,
        );
      }
      out.push(tok);
    } else {
      // Value token — path-validate unless it clearly isn't a path (no slash, no dot, short).
      // Conservative: treat as path only if it looks pathy; otherwise allow as a literal scalar
      // (e.g. a preset name like "all"). Scalars can't redirect output.
      // ".." / "." are always path-like regardless of length — a bare ".." is a
      // relative-traversal token that must never skip path validation.
      const looksPathy = tok.includes("/") || tok === ".." || tok === "." || (tok.includes(".") && tok.length > 4);
      if (looksPathy) {
        assertPathAllowed(tok, roots, { kind: "extraArgs value" });
      } else {
        rejectFlagLike(tok, "extraArgs scalar");
      }
      out.push(tok);
    }
  }
  return out;
}

/** Resolve the default MLX output dir, mirroring run.py / flux2's own resolution. */
export function resolveOutputDir(repoRoot: string, override?: string): string {
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : pResolve(repoRoot, override);
  }
  if (process.env.MLX_OUTPUT_DIR) return pResolve(process.env.MLX_OUTPUT_DIR);
  // flux2 default: repo/../video_generation__output
  return pResolve(repoRoot, "..", "video_generation__output");
}

/**
 * Resolve the output dir and guarantee it exists (write target). A missing
 * sibling `../video_generation__output` would otherwise surface as an opaque
 * `ENOENT` deep in the Swift write path. Mirrors the obsidian vault's
 * create-if-missing philosophy. Returns the resolved absolute path.
 */
export function ensureOutputDir(repoRoot: string, override?: string): string {
  const dir = resolveOutputDir(repoRoot, override);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the models root, mirroring GlobalOptions.models-root / $MLX_MODELS_DIR. */
export function resolveModelsRoot(repoRoot: string, override?: string): string {
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : pResolve(repoRoot, override);
  }
  if (process.env.MLX_MODELS_DIR) return pResolve(process.env.MLX_MODELS_DIR);
  return pResolve(repoRoot, "mlx-models");
}

/**
 * Assert the models root exists (read target). Generation cannot work without
 * the model tree; a missing dir would otherwise surface as an opaque MLX/Swift
 * downstream error. Throws an actionable PathSafetyError at the boundary.
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
