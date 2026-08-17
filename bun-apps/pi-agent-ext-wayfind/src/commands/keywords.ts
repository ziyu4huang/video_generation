/**
 * Reserved-keyword tables shared by the /wayfind dispatcher (commands.ts) and
 * the pure helpers (help.ts) / handlers (wayfind-handlers.ts). Split out of
 * commands.ts (Task 9) so each consumer imports without a cycle.
 */

export const WAYFIND_KEYWORDS = new Set([
  "status",
  "spec",
  "tickets",
  "seed",
  "sync",
  "done",
  "validate",
  "statusbar",
  "help",
  "usage",
]);

/** Subcommand keywords whose remainder is NOT an effort id — the dispatcher
 *  never banners these (statusbar takes on|off; help/usage take nothing). */
export const NO_BANNER_KEYWORDS = new Set(["statusbar", "help", "usage"]);

// Guard: placeholder words passed as destinations almost always mean "work the next frontier", not a new effort named e.g. "next".
export const PLACEHOLDER_DESTINATIONS = new Set([
  "next",
  "continue",
  "later",
  "now",
  "new",
  "todo",
  "today",
  "current",
  "frontier",
  "latest",
]);
