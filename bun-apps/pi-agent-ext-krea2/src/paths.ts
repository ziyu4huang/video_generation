/**
 * paths.ts — path-safety + argv-injection guards for the krea2 tool.
 *
 * The agent supplies image paths and (via extraArgs) raw flag tokens. Both are
 * attacker-controllable from the model's perspective: a path that resolves
 * outside an allowed root, or a token that starts with "-", can hijack the
 * krea2 invocation (e.g. overwrite an arbitrary file, or inject `--out /etc/x`).
 * See memory [[argv-injection-positional-paths]].
 *
 * Guarantees enforced here:
 *   • every image path resolves UNDER an allowed root;
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
 * tail.
 */
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
    throw new PathSafetyError(`${kind}: value "${raw}" looks like a flag (leading '-'), refusing to pass to krea2`);
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
      `${kind}: value "${value}" looks like a flag (leading '-'), refusing to pass to krea2`,
    );
  }
}

/**
 * Validate that `value` is a bare path COMPONENT (a model/variant name the
 * Swift binary joins onto a models-tree root itself via a raw
 * appendingPathComponent), NOT a path this tool resolves. The Swift side does
 * that join with NO ".."-sanitization, so a value containing a path separator
 * or a ".." segment would let the Swift binary read model weights from outside
 * the intended models tree entirely.
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
      const stripped = tok.replace(/^-+/, "");
      const flagName = stripped.split("=")[0] ?? "";
      if (!prefixSet.has(flagName)) {
        throw new PathSafetyError(
          `extraArgs: flag "${tok}" is not allow-listed. Allowed: ${[...prefixSet].sort().join(", ")}`,
        );
      }
      out.push(tok);
    } else {
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

/** Resolve the default MLX output dir, mirroring krea2 Paths.swift's own resolution. */
export function resolveOutputDir(repoRoot: string, override?: string): string {
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : pResolve(repoRoot, override);
  }
  if (process.env.MLX_OUTPUT_DIR) return pResolve(process.env.MLX_OUTPUT_DIR);
  // krea2 default (Paths.swift): repo/../video_generation__output
  return pResolve(repoRoot, "..", "video_generation__output");
}

/**
 * Resolve the output dir and guarantee it exists (write target). A missing
 * sibling `../video_generation__output` would otherwise surface as an opaque
 * `ENOENT` deep in the Swift write path. Returns the resolved absolute path.
 */
export function ensureOutputDir(repoRoot: string, override?: string): string {
  const dir = resolveOutputDir(repoRoot, override);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the models root, mirroring $MLX_MODELS_DIR / mlx-models. */
export function resolveModelsRoot(repoRoot: string, override?: string): string {
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : pResolve(repoRoot, override);
  }
  if (process.env.MLX_MODELS_DIR) return pResolve(process.env.MLX_MODELS_DIR);
  return pResolve(repoRoot, "mlx-models");
}

/** stat helper, symlink-aware. */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
