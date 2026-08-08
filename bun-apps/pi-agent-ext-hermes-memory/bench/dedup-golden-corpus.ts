/**
 * bench/dedup-golden-corpus.ts — labeled golden corpus for the dedup-quality
 * baseline (wayfinder ticket 07). Ground-truth pairs scoring the CURRENT
 * detection layers:
 *   - exact            (memory-store dedupEntries / dedupNormalize)
 *   - near-dup         (near-dup.findNearDuplicate @ threshold, default 0.60)
 *   - topic-recurrence (topic-key.findTopicRecurrence)
 * Methodology locked in ticket 02: hybrid real+synthetic; P/R/F1 per layer +
 * near-dup threshold sweep 0.3-0.9 vs current 0.60; detection-quality only
 * (conflict/merge-plan OUT OF SCOPE).
 *
 * Pairs are GENERATED. near-dup containment and topicKey are computed at
 * module load via the REAL exported dedup functions, so near-dup/topic labels
 * are grounded in actual detection semantics. exact-dup pairs use byte-identical
 * or whitespace variants that any reasonable normalizer collapses; a local
 * normalizer (trim + collapse whitespace) asserts each is normalize-equal.
 *
 * Honesty caveat: seeds are realistic memory-style content mirroring families
 * cited in the effort map (await_pr_merge recurrence, tool-quirks, repo SOP),
 * NOT verbatim lifts from the live MEMORY.md. A later pass can raise real-seed
 * fidelity; baseline shape is unaffected. Hence all source:"synthetic".
 */
import { nearDupTokens, containment } from "../src/store/near-dup.ts";
import { topicKey } from "../src/store/topic-key.ts";

export type DedupLabel = "exact-dup" | "near-dup" | "non-dup" | "topic-recurrence";

export interface GoldenPair {
  id: string;
  a: string;
  b: string;
  label: DedupLabel;
  expectedLayers: ("exact" | "near-dup" | "topic")[];
  containment?: number;
  containmentAB?: number;
  containmentBA?: number;
  topicKeyShared?: boolean;
  note?: string;
  source: "real" | "synthetic";
}

function localNormalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

const bothWays = (a: string, b: string): { ab: number; ba: number; max: number } => {
  const ta = nearDupTokens(a), tb = nearDupTokens(b);
  const ab = containment(ta, tb);
  const ba = containment(tb, ta);
  return { ab, ba, max: Math.max(ab, ba) };
};

const SEEDS: string[] = [
  "gh ship waits for remote CI; use squash merge immediately after local checks pass",
  "Never top-level cd in this repo; use a subshell like cd dir and cmd or pass cwd",
  "Run bun install from bun-apps never from the repo root; bun lock is canonical",
  "Response language is force-controlled by responseLanguage in settings json",
  "MLX dtypes use bfloat16 native; quantize mlx-8bit default or 4-bit; no FP8",
  "SurrealDB syncMemoryEntriesBatch has an OR-chain parser-recursion bug at scale",
  "pi wayfinder produces decisions not deliverables; plan do not do by default",
  "memory dedup is MD-layer only; SQLite and Surreal do identity-only sync dedup",
];

function exactDupPairs(): GoldenPair[] {
  const out: GoldenPair[] = [];
  const variants: Array<{ b: (s: string) => string; note: string }> = [
    { b: (s) => s, note: "byte-identical" },
    { b: (s) => s.replace(/ /g, "  "), note: "double internal space" },
    { b: (s) => "   " + s.trim() + "   ", note: "leading/trailing space" },
    { b: (s) => s.replace(/ /g, "\t"), note: "tabs for spaces" },
  ];
  for (const seed of SEEDS) {
    for (const v of variants) {
      const b = v.b(seed);
      if (localNormalize(seed) !== localNormalize(b)) continue;
      out.push({ id: "", a: seed, b, label: "exact-dup", expectedLayers: ["exact"], note: v.note, source: "synthetic" });
    }
  }
  return out;
}

const NEAR_CANDIDATES: Array<[string, string, string]> = [
  ["gh ship waits for remote CI; use squash merge immediately after local checks pass", "after local checks pass squash merge immediately; gh ship blocks on remote CI", "paraphrase reorder"],
  ["gh ship waits for remote CI; use squash merge immediately after local checks pass", "use squash merge right after local checks pass", "subset"],
  ["Never top-level cd in this repo; use a subshell like cd dir and cmd or pass cwd", "avoid top-level cd; prefer a subshell or the cwd flag", "paraphrase"],
  ["Never top-level cd in this repo; use a subshell like cd dir and cmd or pass cwd", "use the cwd flag or a subshell instead of top-level cd", "compress"],
  ["Run bun install from bun-apps never from the repo root; bun lock is canonical", "bun lock is the canonical lockfile; run bun install inside bun-apps not the repo root", "reorder"],
  ["Run bun install from bun-apps never from the repo root; bun lock is canonical", "bun lock is canonical", "heavy subset"],
  ["Response language is force-controlled by responseLanguage in settings json", "the reply language is governed by responseLanguage in settings json", "synonym"],
  ["Response language is force-controlled by responseLanguage in settings json", "settings json responseLanguage force-controls reply language", "reorder"],
  ["MLX dtypes use bfloat16 native; quantize mlx-8bit default or 4-bit; no FP8", "MLX uses bfloat16 natively; quantization is mlx-8bit default or 4-bit; FP8 unsupported", "expand"],
  ["MLX dtypes use bfloat16 native; quantize mlx-8bit default or 4-bit; no FP8", "MLX dtypes bfloat16 native mlx-8bit or 4-bit quant no FP8", "compress"],
  ["SurrealDB syncMemoryEntriesBatch has an OR-chain parser-recursion bug at scale", "syncMemoryEntriesBatch in SurrealDB recurses on OR-chains at scale", "reorder"],
  ["SurrealDB syncMemoryEntriesBatch has an OR-chain parser-recursion bug at scale", "SurrealDB has a parser-recursion bug in syncMemoryEntriesBatch", "subset"],
  ["pi wayfinder produces decisions not deliverables; plan do not do by default", "wayfinder is planning by default it yields decisions not deliverables", "paraphrase"],
  ["pi wayfinder produces decisions not deliverables; plan do not do by default", "wayfinder decisions not deliverables", "subset"],
  ["memory dedup is MD-layer only; SQLite and Surreal do identity-only sync dedup", "dedup lives in the MD layer only; SQLite and Surreal sync dedup is identity-only", "paraphrase"],
  ["memory dedup is MD-layer only; SQLite and Surreal do identity-only sync dedup", "MD-layer dedup only; SQLite and Surreal identity-only", "compress"],
  ["gh ship waits for remote CI; use squash merge immediately after local checks pass", "after local verification succeeds merge via squash at once; do not block on remote CI", "synonym rewrite"],
  ["Never top-level cd in this repo; use a subshell like cd dir and cmd or pass cwd", "do not change directory at top level; invoke commands inside a subshell or supply the working directory flag", "synonym rewrite"],
  ["Run bun install from bun-apps never from the repo root; bun lock is canonical", "install dependencies from the bun-apps workspace not the repository root; the lockfile of record is bun lock", "synonym rewrite"],
  ["Response language is force-controlled by responseLanguage in settings json", "the assistant tongue is pinned by the responseLanguage key inside settings json", "synonym rewrite"],
  ["MLX dtypes use bfloat16 native; quantize mlx-8bit default or 4-bit; no FP8", "MLX dtypes use bfloat16 native; quantize mlx-8bit default or 4-bit; no FP8; SDPA only no CUDA", "superset"],
  ["pi wayfinder produces decisions not deliverables; plan do not do by default", "pi wayfinder produces decisions not deliverables; plan do not do by default; one decision per ticket", "superset"],
];

function nearDupPairs(): GoldenPair[] {
  return NEAR_CANDIDATES.map(([a, b, note]) => {
    const { ab, ba, max } = bothWays(a, b);
    return { id: "", a, b, label: "near-dup" as const, expectedLayers: ["near-dup" as const], containment: round(max), containmentAB: round(ab), containmentBA: round(ba), note, source: "synthetic" as const };
  });
}

const TOPIC_CANDIDATES: Array<[string, string, string]> = [
  // Family: await_merge_ship
  ["await merge ship squash merge after local ci passes green", "await merge ship never use the auto flag waiting for remote", "family await_merge_ship"],
  ["await merge ship squash merge after local ci passes green", "await merge ship rebase onto origin main before charting map", "family await_merge_ship"],
  ["await merge ship never use the auto flag waiting for remote", "await merge ship rebase onto origin main before charting map", "family await_merge_ship"],
  // Family: memory_dedup_lives
  ["memory dedup lives in the MD layer only canonically", "memory dedup lives behind a warn do not block policy", "family memory_dedup_lives"],
  ["memory dedup lives in the MD layer only canonically", "memory dedup lives outside the SQLite sync identity path", "family memory_dedup_lives"],
  ["memory dedup lives behind a warn do not block policy", "memory dedup lives outside the SQLite sync identity path", "family memory_dedup_lives"],
  // Family: wayfinder_tickets_decisions
  ["wayfinder tickets decisions not tasks by design default", "wayfinder tickets decisions resolve one question each session", "family wayfinder_tickets_decisions"],
  ["wayfinder tickets decisions not tasks by design default", "wayfinder tickets decisions graduate from the fog of war", "family wayfinder_tickets_decisions"],
  ["wayfinder tickets decisions resolve one question each session", "wayfinder tickets decisions graduate from the fog of war", "family wayfinder_tickets_decisions"],
  // Family: dtypes_bfloat16_native
  ["dtypes bfloat16 native on Apple Silicon MLX pipeline", "dtypes bfloat16 native means no float32 fallback path", "family dtypes_bfloat16_native"],
  ["dtypes bfloat16 native on Apple Silicon MLX pipeline", "dtypes bfloat16 native quantize to mlx-8bit by default", "family dtypes_bfloat16_native"],
  ["dtypes bfloat16 native means no float32 fallback path", "dtypes bfloat16 native quantize to mlx-8bit by default", "family dtypes_bfloat16_native"],
  // Family: install_only_inside
  ["install only inside the bun-apps workspace root dir", "install only inside bun-apps per the monorepo SOP rule", "family install_only_inside"],
  ["install only inside the bun-apps workspace root dir", "install only inside bun-apps to keep the lockfile canonical", "family install_only_inside"],
  ["install only inside bun-apps per the monorepo SOP rule", "install only inside bun-apps to keep the lockfile canonical", "family install_only_inside"],
];

function topicRecurrencePairs(): GoldenPair[] {
  const out: GoldenPair[] = [];
  for (const [a, b, note] of TOPIC_CANDIDATES) {
    if (topicKey(a) !== topicKey(b)) continue;
    const { max } = bothWays(a, b);
    if (max > 0.5) continue;
    out.push({ id: "", a, b, label: "topic-recurrence", expectedLayers: ["topic"], topicKeyShared: true, containment: round(max), note, source: "synthetic" });
  }
  return out;
}

function nonDupPairs(): GoldenPair[] {
  const out: GoldenPair[] = [];
  const n = SEEDS.length;
  for (let i = 0; i < n; i++) {
    for (const j of [(i + 3) % n, (i + 5) % n]) {
      const a = SEEDS[i], b = SEEDS[j];
      const { max } = bothWays(a, b);
      if (max > 0.35) continue;
      if (topicKey(a) === topicKey(b)) continue;
      out.push({ id: "", a, b, label: "non-dup", expectedLayers: [], containment: round(max), note: "distinct topics", source: "synthetic" });
    }
  }
  return out;
}

export const GOLDEN_PAIRS: GoldenPair[] = [
  ...exactDupPairs(),
  ...nearDupPairs(),
  ...topicRecurrencePairs(),
  ...nonDupPairs(),
].map((p, i) => ({ ...p, id: `${p.label}-${String(i + 1).padStart(3, "0")}` }));

export const GOLDEN_STATS = {
  total: GOLDEN_PAIRS.length,
  byLabel: GOLDEN_PAIRS.reduce((m, p) => (m[p.label] = (m[p.label] || 0) + 1, m), {} as Record<DedupLabel, number>),
  nearDupContainment: GOLDEN_PAIRS.filter((p) => p.label === "near-dup").map((p) => p.containment!).sort((a, b) => a - b),
  topicAllShared: GOLDEN_PAIRS.filter((p) => p.label === "topic-recurrence").every((p) => p.topicKeyShared),
  exactCount: GOLDEN_PAIRS.filter((p) => p.label === "exact-dup").length,
};
