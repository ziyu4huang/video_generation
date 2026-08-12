import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "../src/render-markdown.js";

describe("renderMarkdown", () => {
  it("renders an h1 heading + bold", () => {
    const html = renderMarkdown("# Hello\n\n**world**");
    expect(html).toContain("<h1");
    expect(html).toContain("Hello");
    expect(html).toContain("<strong>world</strong>");
  });

  it("renders a fenced code block", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("renders a list", () => {
    const html = renderMarkdown("- one\n- two\n");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("returns a string (never a Promise)", () => {
    const html = renderMarkdown("# x");
    expect(typeof html).toBe("string");
  });

  it("empty input yields a string", () => {
    expect(typeof renderMarkdown("")).toBe("string");
  });
});
