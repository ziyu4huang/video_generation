import { test, expect } from "bun:test";
import { mergeByKey } from "./knowledge-db";

// Regression: exportStructuredToDb used to fs.writeFileSync (full overwrite) per
// category, so every knowledge:learn call discarded accumulated/seeded knowledge
// and the self-learning loop forgot everything each iteration. mergeByKey is the
// pure accumulate core — these tests lock the preservation contract.

test("preserves existing entries absent from incoming (the core fix)", () => {
  // avoid.jsonl before: a hand-seeded ceiling entry + a generic entry
  const existing = [
    { item: "Plasticky skin is platform-wide on MLX-quant bases — don't A/B LoRAs for skin" },
    { item: "Generic advice" },
  ];
  // DeepSeek regenerates from a fresh run that knows nothing about the ceiling;
  // it refreshes the generic item (same key) and adds one new observation
  const incoming = [{ item: "Generic advice" }, { item: "New observation" }];
  const merged = mergeByKey(existing, incoming, (a) => a.item.toLowerCase());

  const items = merged.map((m) => m.item);
  expect(items).toContain("Plasticky skin is platform-wide on MLX-quant bases — don't A/B LoRAs for skin");
  expect(items).toContain("New observation");
  expect(merged.length).toBe(3); // ceiling (preserved) + generic (collision→1) + new
});

test("incoming overwrites existing on key collision (latest distillation wins)", () => {
  type Lora = { lora: string; avgScore: number; notes: string };
  const existing: Lora[] = [{ lora: "jib-mix", avgScore: 6, notes: "old notes" }];
  const incoming: Lora[] = [{ lora: "jib-mix", avgScore: 7, notes: "refreshed notes" }];
  const merged = mergeByKey(existing, incoming, (l) => l.lora.toLowerCase());

  expect(merged.length).toBe(1);
  expect(merged[0].notes).toBe("refreshed notes");
  expect(merged[0].avgScore).toBe(7);
});

test("keying is case/whitespace-insensitive (no near-dup accumulation)", () => {
  const existing = [{ item: "  Avoid  X  " }];
  const incoming = [{ item: "avoid x" }];
  const merged = mergeByKey(existing, incoming, (a) => a.item.toLowerCase().trim().replace(/\s+/g, " "));

  expect(merged.length).toBe(1); // incoming refresh wins, not 2 entries
});

test("drops entries with empty keys (malformed input)", () => {
  const existing = [{ item: "" }, { item: "keep" }];
  const incoming = [{ item: "   " }];
  const merged = mergeByKey(existing, incoming, (a) => a.item.trim());

  expect(merged.length).toBe(1);
  expect(merged[0].item).toBe("keep");
});

test("truly-new incoming keys surface first; refreshed + existing-only keep their order", () => {
  const existing = [{ item: "old-A" }, { item: "shared" }, { item: "old-B" }];
  const incoming = [{ item: "shared" }, { item: "fresh" }];
  const merged = mergeByKey(existing, incoming, (a) => a.item);

  // "fresh" is a brand-new key → front. "shared" collides (refreshed in place).
  // "old-A"/"old-B" are existing-only → preserved in original order.
  expect(merged.map((m) => m.item)).toEqual(["fresh", "old-A", "shared", "old-B"]);
});
