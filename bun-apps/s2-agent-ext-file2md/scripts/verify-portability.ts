/**
 * verify-portability.ts — build-time check that bundled output doesn't leak
 * machine-specific absolute paths.
 *
 * Extracted from pi-file2md's build (which only checked macOS `/Users/...`) so the
 * same check can be reused across packages and covers Linux (`/home/...`) and
 * Windows (`C:\Users\...`) layouts too. Returns a list of warning strings
 * (empty when the bundle is portable).
 */

/** A leaked-home-path pattern plus a human label. */
interface LeakPattern {
  re: RegExp;
  label: string;
}

const HOME_PATH_PATTERNS: LeakPattern[] = [
  { re: /\/Users\/[a-z]/i, label: "/Users/..." }, // macOS
  { re: /\/home\/[a-z]/i, label: "/home/..." }, // Linux
  { re: /C:\\Users\\/i, label: "C:\\Users\\..." }, // Windows
];

/**
 * Scan bundled `code` for leaked home-directory absolute paths.
 * Returns zero or more human-readable warning strings.
 *
 * Pass `exclude` regexes to exempt intentional absolute-path embedding
 * (e.g. THIN bundle mode intentionally embeds dep paths): if any exclude
 * regex matches the code, ALL home-path warnings are suppressed.
 */
export function findLeakedHomePaths(code: string, exclude: RegExp[] = []): string[] {
  if (exclude.some((x) => x.test(code))) return [];
  const warnings: string[] = [];
  for (const { re, label } of HOME_PATH_PATTERNS) {
    if (re.test(code)) {
      warnings.push(`absolute ${label} path found in output — leaks local layout`);
    }
  }
  return warnings;
}
