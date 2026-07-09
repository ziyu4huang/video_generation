/**
 * Dangerous-bash command guard.
 *
 * Lives in its own module so it can be unit-tested without pulling in the Pi
 * runtime. Word-boundary regexes so legitimate commands like
 * `git push origin feature/draft-notification` don't trip the warning, but
 * destructive variants like `git push --force` / `git push --mirror` still do.
 * (Plain substring matching was too noisy: every normal push fired the notify
 * and trained users to ignore the warning — v2.40 release notes.)
 */

export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i, // rm -rf, rm -fr, rm -Rf etc.
  /\bsudo\b/i, // sudo invocations
  /\bchmod\s+(0?777|a\+rwx)\b/i, // chmod 777, chmod a+rwx (world-writable)
  /\bgit\s+push\s+.*(--force|-f\b|--mirror|\+)/i, // forced or mirror push only
  /\bgit\s+reset\s+--hard\b/i, // git reset --hard
  /\bgit\s+clean\s+-[a-z]*[fdx]/i, // git clean -fd / -fx / -fdx
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, // shell fork bomb
  /\bdd\s+.*of=\/dev\/[sh]d[a-z]/i, // dd write to a raw disk
];

export function isDangerousBashCommand(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}
