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
import { isAbsolute, resolve as pResolve, sep } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

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

  // Follow symlinks if the target exists so symlinked model stores resolve.
  let real = abs;
  if (existsSync(abs)) {
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
  }

  const allowed = [roots.repoRoot, roots.outputDir, roots.modelsRoot];
  const ok = allowed.some((root) => under(real, root) || under(abs, root));
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
      const flagName = stripped.split("=")[0];
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
      const looksPathy = tok.includes("/") || (tok.includes(".") && tok.length > 4);
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

/** Resolve the models root, mirroring GlobalOptions.models-root / $MLX_MODELS_DIR. */
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
