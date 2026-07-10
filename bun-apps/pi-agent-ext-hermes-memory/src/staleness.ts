/**
 * Staleness audit — pure helpers for detecting outdated memory.
 *
 * Two timestamp dimensions exist in this extension; this module reports the
 * DURABLE one:
 *   - `.md` metadata `last=`  = "last edited" (add/replace)  ← reported here
 *   - SQLite `last_referenced` = "last surfaced by search"   ← bumped in memory-search-tool
 *
 * The audit reads ground-truth `.md` entries via the store's `entriesWithMeta`
 * (every entry, no lagging-index gaps) and flags those not edited within the
 * threshold — direct support for "detect outdated memory".
 */

/** Whole days between today and an ISO `YYYY-MM-DD` string. ∞ if unparseable. */
export function daysSinceEdited(dateStr: string): number {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY; // unparseable → treat as ancient
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** Collapse whitespace and truncate to a one-line preview. */
export function previewOneline(text: string, n = 64): string {
  const oneline = text.replace(/\s+/g, " ").trim();
  return oneline.length > n ? oneline.slice(0, n - 1) + "…" : oneline;
}

/** Minimal store shape the audit needs — accepts MemoryStore or a test mock. */
export interface StalenessReadable {
  entriesWithMeta(target: "memory" | "user" | "failure"): { text: string; created: string; lastReferenced: string }[];
}

/** Build the human-readable staleness report across memory / user / failure. */
export function formatStalenessAudit(
  store: StalenessReadable,
  threshold: number,
  projectName: string | null,
): string {
  const targets: Array<"memory" | "user" | "failure"> = ["memory", "user", "failure"];
  const icon = (t: string) => (t === "user" ? "👤" : t === "failure" ? "⚠️" : "🧠");
  const today = new Date().toISOString().split("T")[0];
  const scope = projectName ? `project: ${projectName}` : "global";

  const perTarget = targets.map((t) => {
    const entries = store
      .entriesWithMeta(t)
      .map((e) => ({ ...e, age: daysSinceEdited(e.lastReferenced) }));
    const stale = entries.filter((e) => e.age > threshold).sort((a, b) => b.age - a.age);
    return { target: t, entries, stale };
  });

  const totalEntries = perTarget.reduce((n, t) => n + t.entries.length, 0);
  const totalStale = perTarget.reduce((n, t) => n + t.stale.length, 0);

  const lines: string[] = [];
  lines.push(`🧠 Memory staleness audit — ${scope}`);
  lines.push(`   threshold: ${threshold} days | generated: ${today} | "last" = last edited (add/replace)`);
  lines.push("");
  lines.push("Summary (entries / stale):");
  for (const t of perTarget) {
    lines.push(`   ${icon(t.target)} ${t.target.padEnd(8)} ${String(t.entries.length).padStart(3)} / ${t.stale.length} stale`);
  }
  lines.push(`   ${"total".padEnd(8)} ${String(totalEntries).padStart(3)} / ${totalStale} stale`);
  lines.push("");

  const allStale = perTarget
    .flatMap((t) => t.stale.map((e) => ({ ...e, target: t.target })))
    .sort((a, b) => b.age - a.age);
  if (allStale.length === 0) {
    lines.push("✓ No stale entries — everything was edited within the threshold.");
  } else {
    const shown = allStale.slice(0, 20);
    const more = allStale.length > 20 ? ` (showing 20 of ${allStale.length})` : "";
    lines.push(`Stale entries, oldest first${more}:`);
    for (const e of shown) {
      const last = e.lastReferenced || "?";
      const ageLabel = Number.isFinite(e.age) ? `${e.age}d` : "?d";
      lines.push(`   ${icon(e.target)} ${last} · ${ageLabel} — ${previewOneline(e.text)}`);
    }
  }
  lines.push("");
  lines.push("Tip: review/refresh stale entries with `memory replace`, or offload durable");
  lines.push("     reference facts to the vault with `memory transfer`.");
  return lines.join("\n");
}
