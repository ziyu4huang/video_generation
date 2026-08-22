#!/usr/bin/env bun
/**
 * update-superpowers.ts — bun twin of the retired scripts/update-superpowers.sh:
 * sync this package's skills/ from a plugin cache version dir. The cache is the
 * canonical sync source; non-exported constants mirror the old shell contract
 * exactly (env name, default path, error text, exit codes, stdout lines).
 *
 * USAGE
 *   bun scripts/update-superpowers.ts [version]
 *     version  plugin version to sync (default: newest under the cache).
 *   CLAUDE_PLUGINS_CACHE  override the plugin cache root.
 */
import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // s2-agent-ext-superpowers/
const CACHE =
  process.env.CLAUDE_PLUGINS_CACHE ??
  join(process.env.HOME ?? "", ".claude-glm/plugins/cache/claude-plugins-official/superpowers");

// ---------------------------------------------------------------------------
// sort -V emulation: a faithful port of the FreeBSD version sort (usr.bin/sort/
// vsort.c vcmp — Apple's /usr/bin/sort -V runs the same algorithm), so the
// "newest cache version" pick is byte-identical to the old `ls | sort -V |
// tail -1`. Differences that matter for version dirs: leading-zero runs,
// numeric vs nonnumeric chunk precedence, '~' sorting before everything, and
// a "suffix" (trailing .<alpha> segments) that is excluded from comparison.
// ---------------------------------------------------------------------------

const END = "\0"; // sentinel for past-the-end (bwstring end iterator yields L'\0')

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c: string): boolean => isDigit(c) || isAlpha(c);

function cmpChars(c1: string, c2: string): number {
  if (c1 === c2) return 0;
  if (c1 === "~") return -1;
  if (c2 === "~") return 1;
  if (isDigit(c1) || c1 === END) return isDigit(c2) || c2 === END ? 0 : -1;
  if (isDigit(c2) || c2 === END) return 1;
  if (isAlpha(c1)) return isAlpha(c2) ? c1.charCodeAt(0) - c2.charCodeAt(0) : -1;
  if (isAlpha(c2)) return 1;
  return c1.charCodeAt(0) - c2.charCodeAt(0);
}

/**
 * Length of the version part: the suffix is the tail beginning at the first
 * `.<alpha>`-anchored extension whose segments stay alnum/~-separated until the
 * end; without one the whole string is the version part. The trailing
 * dangling-dot allowance mirrors FreeBSD's commented-out GNU-compat tightening
 * (kept verbatim).
 */
function findSuffixLen(s: string, start: number, end: number): number {
  let sfx = false;
  let expectAlpha = false;
  let len = 0;
  let clen = 0;
  for (let i = start; i < end; i++) {
    const c = s[i];
    if (expectAlpha) {
      expectAlpha = false;
      if (!isAlpha(c) && c !== "~") sfx = false;
    } else if (c === ".") {
      expectAlpha = true;
      if (!sfx) {
        sfx = true;
        len = clen;
      }
    } else if (!isAlnum(c) && c !== "~") sfx = false;
    clen++;
  }
  if (!sfx) len = clen;
  return len;
}

function compareVersionsBy(s1: string, start1: number, end1: number, s2: string, start2: number, end2: number): number {
  let i1 = start1;
  let i2 = start2;
  while (i1 < end1 || i2 < end2) {
    let diff = 0;
    while ((i1 < end1 && !isDigit(s1[i1])) || (i2 < end2 && !isDigit(s2[i2]))) {
      const c1 = i1 < end1 ? s1[i1] : END;
      const c2 = i2 < end2 ? s2[i2] : END;
      const cmp = cmpChars(c1, c2);
      if (cmp !== 0) return cmp;
      if (i1 < end1) i1++;
      if (i2 < end2) i2++;
    }
    while (i1 < end1 && s1[i1] === "0") i1++;
    while (i2 < end2 && s2[i2] === "0") i2++;
    while (i1 < end1 && i2 < end2 && isDigit(s1[i1]) && isDigit(s2[i2])) {
      if (diff === 0) diff = s1.charCodeAt(i1) - s2.charCodeAt(i2);
      i1++;
      i2++;
    }
    if (i1 < end1 && isDigit(s1[i1])) return 1;
    if (i2 < end2 && isDigit(s2[i2])) return -1;
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Version comparison equivalent to `sort -V` (FreeBSD vcmp). Returns <0, 0, >0.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const cmpBytes = a < b ? -1 : 1; // bwscmp fallback (shorter-first on prefix)
  const len1 = a.length;
  const len2 = b.length;
  if (len1 < 1) return -1;
  if (len2 < 1) return 1;
  const c1 = a[0];
  const c2 = b[0];
  if (c1 === "." && len1 === 1) return -1;
  if (c2 === "." && len2 === 1) return 1;
  if (len1 === 2 && c1 === "." && a[1] === ".") return -1;
  if (len2 === 2 && c2 === "." && b[1] === ".") return 1;
  if (c1 === "." && c2 !== ".") return -1;
  if (c1 !== "." && c2 === ".") return 1;
  let start1 = 0;
  let start2 = 0;
  if (c1 === "." && c2 === ".") {
    start1 = 1;
    start2 = 1;
  }
  const vlen1 = findSuffixLen(a, start1, len1);
  const vlen2 = findSuffixLen(b, start2, len2);
  if (vlen1 === vlen2 && a.slice(start1, start1 + vlen1) === b.slice(start2, start2 + vlen2)) return cmpBytes;
  const cmpRes = compareVersionsBy(a, start1, start1 + vlen1, b, start2, start2 + vlen2);
  return cmpRes === 0 ? cmpBytes : cmpRes;
}

// ---------------------------------------------------------------------------

function main(argv: string[]): void {
  const ver =
    argv[0] ??
    (() => {
      // `ls -1 $CACHE | sort -V | tail -1`: plain ls hides dotfiles; unreadable
      // cache (ENOENT/ENOTDIR) yields an empty list, failing the check below.
      let names: string[] = [];
      try {
        names = readdirSync(CACHE)
          .filter((n) => !n.startsWith("."))
          .sort(compareVersions);
      } catch {
        names = [];
      }
      return names.at(-1);
    })();
  if (ver === undefined) {
    console.error(`error: no superpowers plugin cache at ${CACHE}`);
    process.exit(1);
  }
  const src = join(CACHE, ver, "skills");
  let isDir = false;
  try {
    isDir = statSync(src).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    console.error(`error: ${src} not found`);
    process.exit(1);
  }

  console.log(`▶ sync skills/ from ${CACHE}/${ver}`);
  rmSync(join(PKG, "skills"), { recursive: true, force: true });
  cpSync(src, join(PKG, "skills"), { recursive: true });

  console.log();
  console.log("done. review the diff:  git diff bun-apps/s2-agent-ext-superpowers/skills/");
}

if (import.meta.main) main(process.argv.slice(2));
