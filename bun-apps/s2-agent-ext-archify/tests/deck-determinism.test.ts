/**
 * deck-determinism — the "deterministic translation" gate.
 *
 * The vision claim (rich-decks / D-series): the same deck built twice yields
 * the same PPTX. Measured 2026-09-07 (archify-eval track 3): content parts
 * ARE byte-identical across builds; the only drift is container-level —
 * pptxgenjs stamps `docProps/core.xml` with the current time and jszip stamps
 * every zip entry with the current DOS date. This gate pins both halves:
 *
 *   1. part-level: every part EXCEPT core.xml is byte-equal across two builds
 *      separated by ≥2.2 s (past jszip's 2-second DOS granularity — if the
 *      emitter ever leaks time into a content part, this fails);
 *   2. whole-file level: after canonicalization (core.xml epoch + zeroed DOS
 *      dates) the sha256 of both builds is IDENTICAL.
 *
 * The negative assertions (raw bytes DO differ across builds, canonicalization
 * DOES change them) prove the gate can fail — the same canary discipline as
 * tests/pptx-shapes.test.ts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { buildDeck } from "../src/deck-build.ts";
import { canonicalizePptx } from "../src/pptx-canonical.ts";
import { readZipText } from "../src/read-zip.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_DIR = join(PKG_ROOT, "examples", "deck-composed");
const CORE = "docProps/core.xml";

// Composed layouts (text/table chrome) plus one diagram slide so the shape
// replay path is inside the gate, not only the prose path.
const manifest = {
  output: "determinism.pptx",
  theme: "light",
  slides: [
    {
      layout: "title",
      eyebrow: "DETERMINISM GATE",
      title: "同一份 deck，兩次建置，同一個雜湊",
      date: "2026-09-07",
    },
    {
      layout: "bullets",
      title: "內容決定 parts；時間只准出現在容器",
      bullets: ["core.xml 時間戳固定化", "zip DOS 日期歸零", "其餘 parts 逐 byte 相等"],
    },
    {
      layout: "diagram",
      title: "架構圖也走同一把鎖",
      ir: "../deck/ir/slide1.json",
    },
    {
      layout: "table",
      title: "表格是原生的，也必須重現",
      columns: ["Part", "Determinism"],
      rows: [
        ["slides/*.xml", "byte-identical"],
        ["docProps/core.xml", "canonicalized"],
      ],
    },
  ],
} as const;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function buildOnce(work: string): Promise<Uint8Array> {
  const outputPath = join(work, `determinism-${Math.random().toString(36).slice(2)}.pptx`);
  await buildDeck({
    manifest: manifest as unknown as Parameters<typeof buildDeck>[0]["manifest"],
    manifestDir: MANIFEST_DIR,
    outputPath,
    cwd: PKG_ROOT,
    slidesDir: null,
  });
  return readFileSync(outputPath);
}

describe("deck determinism — same deck, two builds, one hash", () => {
  test(
    "content parts are build-stable; canonicalized whole files hash identically",
    async () => {
      const work = mkdtempSync(join(tmpdir(), "deck-determinism-"));
      try {
        const a = await buildOnce(work);
        await Bun.sleep(2_200); // cross jszip's 2 s DOS granularity AND the ISO second
        const b = await buildOnce(work);

        // 1. Part level: everything except core.xml is byte-equal.
        const partsA = await readZipText(a);
        const partsB = await readZipText(b);
        expect(Object.keys(partsA).sort()).toEqual(Object.keys(partsB).sort());
        const drifting = Object.keys(partsA).filter((p) => partsA[p] !== partsB[p]);
        expect(drifting, "only core.xml may drift across builds").toEqual([CORE]);

        // 2. Canary: the raw whole-file hashes DO differ (the sleep crossed the
        //    timestamp buckets — otherwise this gate would be vacuous).
        expect(sha256(a)).not.toBe(sha256(b));

        // 3. Canonical level: pin core.xml + zero DOS dates → identical hash.
        const canonA = await canonicalizePptx(a);
        const canonB = await canonicalizePptx(b);
        expect(sha256(canonA)).toBe(sha256(canonB));

        // 4. And canonicalization is not a no-op.
        expect(sha256(canonA)).not.toBe(sha256(a));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    120_000
  );
});
