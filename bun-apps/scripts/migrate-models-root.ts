#!/usr/bin/env bun
// migrate-models-root.ts
//
// Migrate the MLX model tree to a new root (default ./mlx-models), rebasing
// every external-store symlink so it still resolves from the new location.
//
// The in-repo model tree is mostly SYMLINKS into the content-addressed external
// store (../video_generation__models/<md5>.safetensors), plus intra-tree
// relative symlinks and real files (manifest.json, README.md, tokenizer bits).
// A plain `cp -a` / `mv` copies symlink target STRINGS verbatim — which then
// resolve from the wrong depth and break. This tool walks the tree and, for
// each symlink, resolves the absolute target via string math (no realpath, so
// dangling links survive) and re-relativizes it against the new parent.
//
// Usage (run from repo root):
//   bun run bun-apps/scripts/migrate-models-root.ts --dry-run
//   bun run bun-apps/scripts/migrate-models-root.ts --force
//   bun run bun-apps/scripts/migrate-models-root.ts --force --move   # rm src after verified copy
//
// store-manifest.json is intentionally NOT rewritten here — regenerate it from
// the new tree via `scripts/externalize_models.py --apply` after this move.

import { parseArgs } from "node:util";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  statSync,
  rmSync,
} from "node:fs";
import { resolve, relative, join, dirname } from "node:path";

type Counts = {
  dirs: number;
  files: number;
  symlinks: number;
  rebased: number; // symlinks whose target string changed
  unchanged: number; // symlinks whose target string stayed the same
};

function walk(src: string): Array<{ abs: string; rel: string }> {
  const out: Array<{ abs: string; rel: string }> = [];
  const stack: Array<{ dir: string; rel: string }> = [{ dir: src, rel: "" }];
  while (stack.length) {
    const { dir, rel } = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const childRel = rel ? join(rel, name) : name;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        out.push({ abs, rel: childRel });
        stack.push({ dir: abs, rel: childRel });
      } else {
        out.push({ abs, rel: childRel });
      }
    }
  }
  return out;
}

function migrate(src: string, dest: string, opts: { dryRun: boolean }) {
  const counts: Counts = { dirs: 0, files: 0, symlinks: 0, rebased: 0, unchanged: 0 };
  const entries = walk(src);
  // Pre-create the dest root so relative-target math has a stable base.
  if (!opts.dryRun) mkdirSync(dest, { recursive: true });

  for (const { abs, rel } of entries) {
    const st = lstatSync(abs);
    const destAbs = join(dest, rel);

    if (st.isDirectory()) {
      counts.dirs++;
      if (!opts.dryRun) mkdirSync(destAbs, { recursive: true });
      continue;
    }

    if (st.isSymbolicLink()) {
      counts.symlinks++;
      const targetStr = readlinkSync(abs); // original (possibly relative) string
      const absTarget = resolve(dirname(abs), targetStr); // absolute, string math only
      // Intra-tree links (target inside src) must be remapped into the dest
      // tree, otherwise they'd point back at the old src location and break
      // once src is removed. External targets (the content store) keep their
      // absolute path and only get re-relativized to the new depth.
      const relInSrc = relative(src, absTarget);
      // Inside src → relInSrc is a forward path (no leading ".."); outside → starts with "..".
      const isIntra = relInSrc !== "" && !relInSrc.startsWith("..");
      const newAbsTarget = isIntra ? join(dest, relInSrc) : absTarget;
      const newRel = relative(dirname(destAbs), newAbsTarget); // re-relativize from new parent
      if (newRel !== targetStr) counts.rebased++;
      else counts.unchanged++;
      if (!opts.dryRun) symlinkSync(newRel, destAbs);
      continue;
    }

    if (st.isFile()) {
      counts.files++;
      if (!opts.dryRun) {
        mkdirSync(dirname(destAbs), { recursive: true });
        copyFileSync(abs, destAbs);
      }
      continue;
    }
    // Skip everything else (sockets, fifos).
  }
  return counts;
}

// After copy, verify every symlink at dest resolves to an existing target.
function verify(dest: string): { total: number; broken: string[] } {
  const broken: string[] = [];
  let total = 0;
  const stack = [dest];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isSymbolicLink()) {
        total++;
        // statSync follows the link; throws / returns no file if dangling.
        try {
          if (!statSync(abs).isFile() && !statSync(abs).isDirectory()) {
            broken.push(abs);
          }
        } catch {
          broken.push(abs);
        }
      }
    }
  }
  return { total, broken };
}

function main() {
  const { values } = parseArgs({
    options: {
      src: { type: "string", default: "python/mlx-movie-director/models" },
      dest: { type: "string", default: "mlx-models" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      move: { type: "boolean", default: false },
    },
    strict: true,
    allowNegative: true,
  });

  const src = resolve(process.cwd(), values.src!);
  const dest = resolve(process.cwd(), values.dest!);
  const dryRun = values["dry-run"];
  const force = values.force;
  const move = values.move;

  if (!existsSync(src)) {
    console.error(`✗ source not found: ${src}`);
    process.exit(1);
  }
  if (src === dest) {
    console.error("✗ source and destination are the same path");
    process.exit(1);
  }
  if (existsSync(dest) && !dryRun && !force) {
    console.error(`✗ destination already exists: ${dest}\n  pass --force to overwrite (it will be removed first)`);
    process.exit(1);
  }

  console.log(`src : ${src}`);
  console.log(`dest: ${dest}`);
  console.log(`mode: ${dryRun ? "DRY-RUN" : "copy"}${move && !dryRun ? " + move" : ""}\n`);

  if (!dryRun && force && existsSync(dest)) {
    console.log(`removing existing dest (--force)…`);
    rmSync(dest, { recursive: true, force: true });
  }

  const counts = migrate(src, dest, { dryRun });
  console.log("copied:", counts);

  if (dryRun) {
    console.log("\n(dry-run: no files written, no verification run)");
    return;
  }

  const v = verify(dest);
  if (v.broken.length) {
    console.error(`\n✗ ${v.broken.length} broken symlink(s) at dest:`);
    for (const b of v.broken.slice(0, 20)) console.error("  " + relative(process.cwd(), b));
    if (v.broken.length > 20) console.error(`  …and ${v.broken.length - 20} more`);
    console.error("  Aborting BEFORE any source removal. Inspect dest then re-run without --move.");
    process.exit(2);
  }
  console.log(`verify: ${v.total} symlinks all resolve ✓`);

  if (move) {
    console.log(`\n--move: removing source ${src}`);
    rmSync(src, { recursive: true, force: true });
    console.log("source removed. Remember to regenerate store-manifest.json at the new root:");
    console.log("  python/venv/bin/python scripts/externalize_models.py --apply");
  } else {
    console.log("\nNext: regenerate store-manifest.json at the new root:");
    console.log("  python/venv/bin/python scripts/externalize_models.py --apply");
    console.log("Source left intact; remove it after tests pass:");
    console.log(`  git rm -r ${relative(process.cwd(), src) || "python/mlx-movie-director/models"}`);
  }
}

main();
