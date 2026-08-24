/**
 * shipped-templates.test.ts — the shipped `templates/*.layout.json` (tickets
 * 06 + 30: seven + the three ir-slot templates).
 *
 * Properties:
 *
 *   1. all ship with zero diagnostics and appear in `catalog()` — they are
 *      data, so this is the whole "shipped" claim;
 *   2. each renders a realistic CJK payload to a `formatBlocks` golden under
 *      `tests/fixtures/templates/<name>.txt`, exactly like the
 *      per-primitive goldens;
 *   3. two templates declaring the SAME role name resolve per-slide without
 *      leakage — the map.md Fog-of-war collision case, proven rather than
 *      assumed.
 *
 * No `.ts` file exists to make them work beyond ticket 05's primitive:
 * that absence is the point of the data-driven seam.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../src/layout-registry.ts";
import { emitPptxSlide } from "../src/emit-pptx.ts";
import { emitHtmlSlide } from "../src/emit-html.ts";
import { PALETTES } from "../src/deck-theme.ts";
import { formatBlocks, type LayoutCtx, type PlacedBlock, type Slide } from "../src/slide-model.ts";
import { spySlide } from "./helpers/spy-slide.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const TPL_DIR = join(PKG, "templates");
const GOLDENS = join(import.meta.dir, "fixtures", "templates");
const CTX: LayoutCtx = { index: 0, total: 1, tag: "archify deck" };

export const SHIPPED = [
  "kpi-row",
  "table",
  "compare",
  "timeline",
  "agenda",
  "quote",
  "end",
  "decision",
  "timeline-with-diagram",
  "figure",
] as const;

/**
 * Realistic CJK payloads — what a platform-review or program deck actually
 * puts on these slides. Never lorem.
 */
const PAYLOADS: Record<(typeof SHIPPED)[number], { slide: Slide; assert: string[] }> = {
  "kpi-row": {
    slide: {
      title: "快取讓冷啟動延遲減半，使用者才回得來",
      takeaway: "先做解析器快取，其餘延後",
      kpis: [
        { value: "4.2 s", label: "冷啟動 p99", note: "快取後降至 1.8 s" },
        { value: "38%", label: "快取命中率", note: "上線四週量測" },
        { value: "17 ms", label: "熱路徑延遲" },
      ],
    } as unknown as Slide,
    assert: ["4.2 s", "冷啟動 p99", "38%", "17 ms"],
  },
  table: {
    slide: {
      title: "三條關鍵路徑中，解析器獨占八成預算",
      takeaway: "解析器是唯一值得先動刀的路徑",
      columns: ["服務", "p99", "p50"],
      rows: [
        ["解析器", "4.2 s", "1.8 s"],
        ["影像服務", "210 ms", "180 ms"],
        ["通知佇列", "95 ms", "88 ms"],
      ],
      note: "資料期間：2026 年 7 月，生產環境抽樣",
    } as unknown as Slide,
    assert: ["服務", "影像服務", "95 ms", "2026 年 7 月"],
  },
  compare: {
    slide: {
      title: "自建解析器在第二年反超託管服務的成本線",
      sides: [
        {
          heading: "自建解析器",
          bullets: ["p99 由 4.2 s 壓到 1.8 s", "維運成本每月增加 12 小時", "資料不出內網"],
        },
        {
          heading: "採用託管服務",
          bullets: ["零維運，但單價高 2.3 倍", "資料出境需法務審查", "第二年合約重議"],
        },
      ],
    } as unknown as Slide,
    assert: ["自建解析器", "零維運，但單價高 2.3 倍", "第二年合約重議"],
  },
  timeline: {
    slide: {
      title: "四個季度走完解析器移行，Q2 是唯一硬關卡",
      milestones: [
        { date: "Q1", label: "需求凍結", note: "RFQ 回覆完成" },
        { date: "Q2", label: "架構定案" },
        { date: "Q3", label: "量產驗證", note: "PPAP 送件" },
        { date: "Q4", label: "SOP 發布" },
      ],
    } as unknown as Slide,
    assert: ["Q1", "需求凍結", "PPAP 送件", "SOP 發布"],
  },
  agenda: {
    slide: {
      title: "今天只決策一件事：解析器自建或採購",
      items: [
        { title: "現況與痛點", note: "10 分鐘" },
        { title: "解析器基準測試", note: "15 分鐘" },
        { title: "移行計畫", note: "20 分鐘" },
        { title: "決策與下一步" },
      ],
    } as unknown as Slide,
    assert: ["現況與痛點", "15 分鐘", "決策與下一步"],
  },
  quote: {
    slide: {
      title: "引言",
      quote: "任何架構問題都能用多加一層間接層解決——除了間接層太多的問題。",
      attribution: "巴特勒·蘭普森",
      role: "圖靈獎得主，1993",
    } as unknown as Slide,
    assert: ["間接層", "— 巴特勒·蘭普森", "圖靈獎得主，1993"],
  },
  end: {
    slide: {
      headline: "謝謝——進入問題與討論",
      contact: "archify@team.example",
    } as unknown as Slide,
    assert: ["謝謝——進入問題與討論", "archify@team.example"],
  },
  // ticket 30 — the ir-slot templates. The diagram binding carries the slide's
  // `ir` into BlockContent; the unit render never touches the filesystem, so a
  // relative-looking path string is fine here (the deck-build absolutizes it).
  decision: {
    slide: {
      title: "決策：快取優先，下一季度全程上線",
      ir: "ir/service-topology.architecture.json",
      call: "自建解析器，快取優先，Q2 全程上線。",
      why: "p99 4.2 s → 1.8 s；佇列是唯一保留的結耦。",
    } as unknown as Slide,
    assert: ['diagram "ir/service-topology.architecture.json"', "自建解析器，快取優先，Q2 全程上線。", "佇列是唯一保留的結耦。"],
  },
  "timeline-with-diagram": {
    slide: {
      title: "移行四季度，與追蹤管線步調一致",
      ir: "ir/trace-pipeline.dataflow.json",
      milestones: [
        { date: "Q1", label: "架構完成", note: "冷鏈路接上管線" },
        { date: "Q2", label: "閘門上線" },
        { date: "Q3", label: "快取命中", note: "38 % 命中率" },
        { date: "Q4", label: "全程上線" },
      ],
    } as unknown as Slide,
    assert: ['diagram "ir/trace-pipeline.dataflow.json"', "Q1", "冷鏈路接上管線", "38 % 命中率", "全程上線"],
  },
  figure: {
    slide: {
      title: "規格鏈正是整個系統的原始碼",
      ir: "ir/req-chain.architecture.json",
      caption: "需求鏈：MRD → SAS → MAS → RDS",
      note: "成對存在，缺一件即不可交付。",
    } as unknown as Slide,
    assert: ['diagram "ir/req-chain.architecture.json"', "需求鏈：MRD → SAS → MAS → RDS", "缺一件即不可交付。"],
  },
};

describe("the seven ship as data and nothing else", () => {
  const reg = loadRegistry({ env: {} });

  test("all seven load clean and appear in catalog(), after the six code layouts", () => {
    const names = reg.names();
    expect(names.slice(0, 6)).toEqual(["title", "section", "bullets", "split", "diagram", "statement"]);
    for (const n of SHIPPED) expect(names, n).toContain(n);
    const catalog = reg.catalog();
    for (const n of SHIPPED) {
      const entry = catalog.find((c) => c.name === n);
      expect(entry, n).toBeDefined();
      // The description is what the agent reads; it must say something.
      expect(entry!.description.length).toBeGreaterThan(20);
      expect(entry!.source.startsWith(TPL_DIR)).toBe(true);
    }
  });

  test("each description carries its discriminating load", () => {
    const catalog = reg.catalog();
    // quote vs statement is decided in prose, not code.
    expect(catalog.find((c) => c.name === "quote")!.description).toMatch(/statement/);
    // compare-is-50/50-vs-split-60/40 likewise.
    expect(catalog.find((c) => c.name === "compare")!.description).toMatch(/50\/50/);
    expect(catalog.find((c) => c.name === "compare")!.description).toMatch(/60\/40/);
  });

  test("no shipped name shadows a code layout, and every file parses", () => {
    // A throw anywhere above IS this test failing; here we pin the count.
    expect(reg.catalog().filter((c) => c.source.startsWith(TPL_DIR))).toHaveLength(10);
  });
});

describe("formatBlocks goldens — one per template, realistic CJK payloads", () => {
  test.each([...SHIPPED])("%s", async (name) => {
    const reg = loadRegistry({ env: {} });
    const blocks = reg.render(name, PAYLOADS[name]!.slide, CTX);
    const got = `${formatBlocks(blocks)}\n`;
    for (const s of PAYLOADS[name]!.assert) expect(got, s).toContain(s);

    const path = join(GOLDENS, `${name}.txt`);
    if (process.env["UPDATE_TEMPLATE_GOLDENS"] === "1" || !existsSync(path)) {
      mkdirSync(GOLDENS, { recursive: true });
      await Bun.write(path, got);
    }
    expect(got).toBe(await Bun.file(path).text());
  });

  test("the ir-slot decision template's diagram iframe + text reach the HTML emitter (ticket 30)", () => {
    const reg = loadRegistry({ env: {} });
    const PAYLOAD = PAYLOADS.decision!.slide;
    const blocks = reg.render("decision", PAYLOAD, CTX);
    const html = emitHtmlSlide(blocks, {
      theme: "light",
      palette: PALETTES.light,
      font: "PingFang TC",
      title: PAYLOAD.title as string,
      diagramSrc: new Map([
        ["ir/service-topology.architecture.json", { file: "slide-11.diagram.html", aspect: 1.2 }],
      ]),
    });
    expect(html).toContain("slide-11.diagram.html"); // the embed iframe is the diagram
    expect(html).toContain("自建解析器，快取優先，Q2 全程上線。");
    expect(html).toContain("佇列是唯一保留的結耦。");
  });

  test("every authored CJK string reaches both emitters", () => {
    // Spot-check the twin property on the one template with a new drawing
    // primitive: the table's cells must survive into the pptx call.
    const reg = loadRegistry({ env: {} });
    const blocks = reg.render("table", PAYLOADS.table!.slide, CTX);
    const slide = spySlide();
    emitPptxSlide(slide, blocks, {
      palette: PALETTES.light,
      theme: "light",
      font: "PingFang TC",
      diagrams: new Map(),
      roleOf: reg.roleOf("table"),
    });
    const tables = slide.calls.filter((c) => c.fn === "addTable");
    expect(tables).toHaveLength(1);
    const rows = tables[0]!.rows as { text: string }[][];
    expect(rows[0]!.map((c) => c.text)).toEqual(["服務", "p99", "p50"]);
    expect(rows.map((r) => r.map((c) => c.text))).toContainEqual([
      "解析器",
      "4.2 s",
      "1.8 s",
    ]);
    expect(tables[0]!.opts["autoPage"]).toBe(false);
  });
});

describe("role collision — two templates declaring the same role name resolve per-slide", () => {
  const dirA = mkdtempSync(join(tmpdir(), "archify-collide-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "archify-collide-b-"));
  afterAll(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  function writeColliding(dir: string, name: string, sizePt: number): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.layout.json`),
      JSON.stringify({
        name,
        description: `${name} collision probe`,
        chrome: false,
        roles: { panelLabel: { sizePt, bold: sizePt > 20, color: sizePt > 20 ? "title" : "muted" } },
        body: [
          {
            region: "content",
            box: "fill",
            content: { kind: "text", role: "panelLabel", from: "{slide.title}" },
          },
        ],
      })
    );
  }

  test("each slide paints its OWN spec — no leakage across templates", () => {
    writeColliding(dirA, "coll-a", 30);
    writeColliding(dirB, "coll-b", 12);
    // Same-tier duplicates are an error; different tiers are precedence, and
    // BOTH names stay reachable because the names differ.
    const reg = loadRegistry({ env: { ARCHIFY_TEMPLATES: dirA }, shippedDir: dirB });

    expect(reg.roleOf("coll-a")("panelLabel").sizePt).toBe(30);
    expect(reg.roleOf("coll-b")("panelLabel").sizePt).toBe(12);
    // And the builtins between them are untouched by either merge.
    expect(reg.roleOf("bullets")("panelLabel").color).toBe("body");

    for (const [name, sizePt, color] of [
      ["coll-a", 30, PALETTES.light.title],
      ["coll-b", 12, PALETTES.light.muted],
    ] as const) {
      const slide = spySlide();
      emitPptxSlide(
        slide,
        reg.render(name, { title: "共用角色名稱" }, CTX),
        {
          palette: PALETTES.light,
          theme: "light",
          font: "PingFang TC",
          diagrams: new Map(),
          roleOf: reg.roleOf(name),
        }
      );
      const call = slide.calls.find((c) => c.fn === "addText")!;
      expect(call.opts["fontSize"]).toBe(sizePt);
      expect(call.opts["color"]).toBe(color);
    }
  });
});
