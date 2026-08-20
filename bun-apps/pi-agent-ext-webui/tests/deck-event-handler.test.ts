import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeckEventHandler,
  resolveDeckSlides,
  type DiagramDeckFrame,
} from "../src/deck-event-handler.js";

let root = "";
let outside = "";
const frames: DiagramDeckFrame[] = [];
const logs: unknown[][] = [];
const origLog = console.log;

function handler(roots: string[] = [root]) {
  return createDeckEventHandler(roots, {
    getUrl: () => "http://127.0.0.1:1234",
    broadcast: (f) => frames.push(f),
    now: () => 1_700_000_000_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "webui-deck-root-"));
  outside = mkdtempSync(join(tmpdir(), "webui-deck-outside-"));
  writeFileSync(join(root, "a.html"), "<svg/>");
  writeFileSync(join(root, "b.html"), "<svg/>");
  writeFileSync(join(outside, "secret.html"), "<svg/>");
  frames.length = 0;
  logs.length = 0;
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
});

afterEach(() => {
  console.log = origLog;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("happy path", () => {
  test("resolves every slide to a /files URL, in order", () => {
    handler()({
      deckId: "my-deck",
      title: "My deck",
      slides: [
        { path: join(root, "a.html"), title: "One", subtitle: "first" },
        { path: join(root, "b.html"), title: "Two" },
      ],
    });
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.type).toBe("diagram_deck");
    expect(f.deckId).toBe("my-deck");
    expect(f.title).toBe("My deck");
    expect(f.ts).toBe(1_700_000_000_000);
    expect(f.slides).toEqual([
      { url: "http://127.0.0.1:1234/files/0/a.html", title: "One", subtitle: "first" },
      { url: "http://127.0.0.1:1234/files/0/b.html", title: "Two" },
    ]);
  });

  test("selects the right root index across several roots", () => {
    const second = mkdtempSync(join(tmpdir(), "webui-deck-root2-"));
    try {
      writeFileSync(join(second, "c.html"), "<svg/>");
      handler([root, second])({
        deckId: "d",
        slides: [{ path: join(second, "c.html") }],
      });
      expect(frames[0]!.slides[0]!.url).toBe("http://127.0.0.1:1234/files/1/c.html");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("percent-encodes each path segment", () => {
    mkdirSync(join(root, "sub dir"));
    writeFileSync(join(root, "sub dir", "a b#c.html"), "<svg/>");
    handler()({ deckId: "d", slides: [{ path: join(root, "sub dir", "a b#c.html") }] });
    expect(frames[0]!.slides[0]!.url).toBe(
      "http://127.0.0.1:1234/files/0/sub%20dir/a%20b%23c.html"
    );
  });

  test("omits absent optional fields rather than emitting empty strings", () => {
    handler()({ deckId: "d", title: "", slides: [{ path: join(root, "a.html"), title: "" }] });
    const f = frames[0]!;
    expect("title" in f).toBe(false);
    expect("title" in f.slides[0]!).toBe(false);
  });
});

describe("containment", () => {
  test("a partially-servable deck keeps the servable slides", () => {
    // Deliberate difference from webui:open — losing a whole deck because one
    // path was misconfigured is worse than losing the one slide.
    handler()({
      deckId: "d",
      slides: [
        { path: join(root, "a.html") },
        { path: join(outside, "secret.html") },
        { path: join(root, "b.html") },
      ],
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.slides.map((s) => s.url)).toEqual([
      "http://127.0.0.1:1234/files/0/a.html",
      "http://127.0.0.1:1234/files/0/b.html",
    ]);
  });

  test("a fully-outside deck is ignored entirely", () => {
    handler()({ deckId: "d", slides: [{ path: join(outside, "secret.html") }] });
    expect(frames).toHaveLength(0);
  });

  test("empty roots serve nothing (fail closed)", () => {
    handler([])({ deckId: "d", slides: [{ path: join(root, "a.html") }] });
    expect(frames).toHaveLength(0);
  });

  test("traversal out of a root is not servable", () => {
    handler()({ deckId: "d", slides: [{ path: join(root, "..", "..", "etc", "passwd") }] });
    expect(frames).toHaveLength(0);
  });

  test("a symlink pointing outside the root is not servable", () => {
    symlinkSync(join(outside, "secret.html"), join(root, "link.html"));
    handler()({ deckId: "d", slides: [{ path: join(root, "link.html") }] });
    expect(frames).toHaveLength(0);
  });

  test("a directory is not servable", () => {
    mkdirSync(join(root, "adir"));
    handler()({ deckId: "d", slides: [{ path: join(root, "adir") }] });
    expect(frames).toHaveLength(0);
  });
});

describe("robustness — the handler never throws", () => {
  const bad: unknown[] = [
    undefined,
    null,
    42,
    "a string",
    [],
    {},
    { deckId: "d" },
    { deckId: "d", slides: [] },
    { deckId: "", slides: [{ path: "/x" }] },
    { deckId: 7, slides: [{ path: "/x" }] },
    { slides: [{ path: "/x" }] },
    { deckId: "d", slides: "not an array" },
    { deckId: "d", slides: [null, 5, { nope: true }] },
  ];

  for (const payload of bad) {
    test(`ignores ${JSON.stringify(payload) ?? "undefined"} without throwing`, () => {
      expect(() => handler()(payload)).not.toThrow();
      expect(frames).toHaveLength(0);
    });
  }

  test("survives a throwing getUrl", () => {
    const h = createDeckEventHandler([root], {
      getUrl: () => {
        throw new Error("server stopped");
      },
      broadcast: (f) => frames.push(f),
    });
    expect(() => h({ deckId: "d", slides: [{ path: join(root, "a.html") }] })).not.toThrow();
    expect(frames).toHaveLength(0);
  });

  test("survives a throwing broadcast", () => {
    const h = createDeckEventHandler([root], {
      getUrl: () => "http://127.0.0.1:1234",
      broadcast: () => {
        throw new Error("socket gone");
      },
    });
    expect(() => h({ deckId: "d", slides: [{ path: join(root, "a.html") }] })).not.toThrow();
  });

  test("every ignore path logs a reason", () => {
    handler()({ deckId: "d", slides: [] });
    expect(logs.some((l) => String(l[0]).includes("webui:deck ignored"))).toBe(true);
  });
});

describe("resolveDeckSlides", () => {
  test("is usable without the bus", () => {
    expect(
      resolveDeckSlides([root], [{ path: join(root, "a.html") }], "http://x")
    ).toEqual([{ url: "http://x/files/0/a.html" }]);
  });

  test("skips non-string paths instead of throwing", () => {
    expect(
      resolveDeckSlides([root], [{ path: 1 as unknown as string }, { path: "" }], "http://x")
    ).toEqual([]);
  });
});

describe("the archify contract", () => {
  /**
   * A payload captured VERBATIM from a real `archify_export_pptx` run
   * (2026-08-21, the 5-slide examples/deck manifest), trimmed to two slides and
   * re-pathed into this test's root.
   *
   * The two packages import nothing from each other — the event shape IS the
   * whole contract — so nothing else pins that archify's emission and this
   * handler's expectation still agree. This fixture does.
   */
  test("consumes a real archify emission, CJK titles and all", () => {
    handler()({
      deckId: "itemize",
      title: "itemize",
      slides: [
        {
          path: join(root, "a.html"),
          title: "為什麼 Itemize？— 一段壞散文 → 原子 Item",
          subtitle: "散文改不動、查不出、驗不了；Itemize 拆成原子、唯一編碼、逐層可追溯",
        },
        {
          path: join(root, "b.html"),
          title: "範例：COCKPIT-26 車用座艙 SoC（只看 SAS 層）",
          subtitle: "MRD → NoC → {AUDIO APU, ISP}",
        },
      ],
    });
    expect(frames).toHaveLength(1);
    const f = frames[0]!;
    expect(f.deckId).toBe("itemize");
    expect(f.slides).toHaveLength(2);
    expect(f.slides[0]!.title).toBe("為什麼 Itemize？— 一段壞散文 → 原子 Item");
    expect(f.slides[0]!.url).toBe("http://127.0.0.1:1234/files/0/a.html");
    expect(f.slides[1]!.subtitle).toBe("MRD → NoC → {AUDIO APU, ISP}");
  });

  test("the deckId is the .pptx basename, so a re-export replaces in place", () => {
    const h = handler();
    h({ deckId: "itemize", slides: [{ path: join(root, "a.html") }] });
    h({ deckId: "itemize", slides: [{ path: join(root, "b.html") }] });
    expect(frames.map((f) => f.deckId)).toEqual(["itemize", "itemize"]);
  });
});
