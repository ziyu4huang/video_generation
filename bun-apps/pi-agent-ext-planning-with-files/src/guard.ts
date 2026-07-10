/**
 * Dangerous-bash command guard.
 *
 * Lives in its own module so it can be unit-tested without pulling in the Pi
 * runtime. Word-boundary regexes so legitimate commands like
 * `git push origin feature/draft-notification` don't trip the warning, but
 * destructive variants like `git push --force` / `git push --mirror` still do.
 * (Plain substring matching was too noisy: every normal push fired the notify
 * and trained users to ignore the warning — v2.40 release notes.)
 *
 * IMPORTANT: `--force-with-lease` / `--force-if-includes` are the SAFE
 * non-destructive variants of force-push (they abort if the remote moved),
 * so the push pattern uses a negative lookahead `--force(?![\w-])` to match
 * bare `--force` only — NOT `--force-with-lease`. A plain substring `--force`
 * matched inside `--force-with-lease` and fired the warning on every rebased
 * push, re-creating the exact cry-wolf problem the word boundaries exist to
 * prevent.
 */

export const DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i, // rm -rf, rm -fr, rm -Rf etc.
  /\bsudo\b/i, // sudo invocations
  /\bchmod\s+(0?777|a\+rwx)\b/i, // chmod 777, chmod a+rwx (world-writable)
  // forced or mirror push only. The negative lookahead (?![\w-]) on --force
  // excludes --force-with-lease / --force-if-includes (safe variants).
  /\bgit\s+push\s+.*(--force(?![\w-])|-f\b|--mirror|\+)/i,
  /\bgit\s+reset\s+--hard\b/i, // git reset --hard
  /\bgit\s+clean\s+-[a-z]*[fdx]/i, // git clean -fd / -fx / -fdx
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, // shell fork bomb
  /\bdd\s+.*of=\/dev\/[sh]d[a-z]/i, // dd write to a raw disk
];

export function isDangerousBashCommand(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}
