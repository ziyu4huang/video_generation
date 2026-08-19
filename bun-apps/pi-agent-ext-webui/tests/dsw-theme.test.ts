/**
 * dsw-theme.test.ts — pins the DeepSeek-harness design-language port
 * (dsh-v0.1.0-rc.7 dark theme) onto the webui shell. RESTYLE ONLY: these
 * tests grid the literal CSS substrings of RENDER_SHELL_HTML so a future
 * edit cannot silently regress the ported palette (values resolved from
 * /Users/huangziyu/proj/deepseek-harness @ 99f6f02fec, packages/client/
 * ui-theme design-platform.css dark block + ui-conversation MessageItem /
 * ConversationRoot module css).
 */
import { describe, expect, test } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

const styleBlock = RENDER_SHELL_HTML.slice(
  RENDER_SHELL_HTML.indexOf("<style>"),
  RENDER_SHELL_HTML.indexOf("</style>"),
);

describe("dsw theme — token block (ported from deepseek-harness ui-theme dark)", () => {
  test("header comment names the port source", () => {
    expect(styleBlock).toContain(
      "/* Design tokens ported from deepseek-harness packages/client/ui-theme (dark theme) — dsh-v0.1.0-rc.7 */",
    );
  });

  test("bg + accent + label tokens carry the exact ported literals", () => {
    expect(styleBlock).toContain("--dsw-alias-bg-base: rgb(21, 21, 23)");
    expect(styleBlock).toContain("--dsw-alias-bg-layer-1: rgb(35, 35, 36)");
    expect(styleBlock).toContain("--dsw-alias-bg-layer-2: rgb(44, 44, 46)");
    expect(styleBlock).toContain("--dsw-alias-state-business-primary: rgb(103, 158, 254)");
    expect(styleBlock).toContain("--dsw-alias-button-info-fill: rgb(103, 158, 254)");
    expect(styleBlock).toContain("--dsw-alias-button-info-hover: rgb(65, 118, 230)");
    expect(styleBlock).toContain("--dsw-alias-label-primary: rgb(249, 250, 251)");
    expect(styleBlock).toContain("--dsw-alias-label-secondary: rgb(207, 211, 214)");
    expect(styleBlock).toContain("--dsw-alias-label-caption: rgb(129, 133, 140)");
    expect(styleBlock).toContain("--dsw-alias-toast-bg: rgb(67, 69, 74)");
    expect(styleBlock).toContain("--dsw-alias-markdown-code-block: rgb(27, 27, 28)");
    expect(styleBlock).toContain("--dsw-alias-markdown-inline-code: rgb(44, 44, 46)");
  });

  test("the full CJK-aware font stack survives verbatim (PingFang SC et al.)", () => {
    expect(styleBlock).toContain(
      "--dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    );
  });
});

describe("dsw theme — shell chrome", () => {
  test("body adopts the dsw base surface + font + antialiasing", () => {
    expect(styleBlock).toContain("font-family: var(--dsw-font-family)");
    expect(styleBlock).toContain("color: var(--dsw-alias-label-primary)");
    expect(styleBlock).toContain("background: var(--dsw-alias-bg-base)");
    expect(styleBlock).toContain("-webkit-font-smoothing: antialiased");
  });

  test("the GitHub-dark #0d1117 surfaces are gone", () => {
    expect(styleBlock).not.toContain("#0d1117");
  });

  test("no #6cf cyan accent survives in the style block", () => {
    expect(styleBlock).not.toMatch(/#6cf/i);
    expect(styleBlock).not.toContain("#9cf");
  });

  test("webkit + firefox thin scrollbars at the ported 8px / rgb(60,60,61)", () => {
    expect(styleBlock).toContain("::-webkit-scrollbar { width: 8px");
    expect(styleBlock).toContain("::-webkit-scrollbar-track { background: transparent; }");
    expect(styleBlock).toContain("::-webkit-scrollbar-thumb { background: rgb(60, 60, 61); border-radius: 4px; }");
    expect(styleBlock).toContain("::-webkit-scrollbar-thumb:hover { background: rgb(84, 85, 87); }");
    expect(styleBlock).toContain("body, body * { scrollbar-width: thin; scrollbar-color: rgb(60, 60, 61) transparent; }");
  });

  test("header border + pill tabs ride the dsw borders/interactives", () => {
    expect(styleBlock).toContain("border-bottom: 1px solid var(--dsw-alias-border-l1)");
    expect(styleBlock).toContain(".tab.active { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); border-color: transparent; }");
  });
});

describe("dsw theme — Inbox chat feed (deepseek conversation geometry)", () => {
  test("#chat-feed centers at the 736px reading measure", () => {
    expect(styleBlock).toContain("max-width: 736px");
  });

  test("user bubble: rgb(44,44,46) pill at 22px radius, 10px 16px padding, 16/24 type", () => {
    expect(styleBlock).toContain("max-width: min(525px, 82%)");
    expect(styleBlock).toContain("border-radius: 22px");
    expect(styleBlock).toContain("padding: 10px 16px");
    expect(styleBlock).toContain("font-size: 16px; line-height: 24px");
    expect(styleBlock).toContain("background: rgb(44, 44, 46)");
    expect(styleBlock).toContain("color: var(--dsw-alias-label-primary)");
  });

  test("assistant rows are bare full-width 16/28 text; chat-md frames transparent", () => {
    expect(styleBlock).toContain("font-size: 16px; line-height: 28px");
    expect(styleBlock).not.toContain(".chat-row.assistant { align-self: stretch; border-left");
    expect(styleBlock).toContain("iframe.chat-md { width: 100%; border: none; background: transparent; }");
  });

  test("mdDoc iframe palette rides the dsw markdown tokens (plain values, no var crossing)", () => {
    const script = RENDER_SHELL_HTML.slice(
      RENDER_SHELL_HTML.indexOf("function mdDoc"),
      RENDER_SHELL_HTML.indexOf("function renderChatAssistant"),
    );
    expect(script).toContain("rgb(249, 250, 251)");
    expect(script).toContain("rgb(27, 27, 28)");
    expect(script).toContain("rgb(44, 44, 46)");
    expect(script).toContain("rgb(103, 158, 254)");
    expect(script).toContain("rgba(255,255,255,0.12)");
    expect(script).toContain("rgb(207,211,214)");
    expect(script).toContain("font-size:16px;line-height:28px");
    // iframe docs cannot inherit :root vars — the palette must stay plain
    expect(script).not.toContain("var(--dsw");
  });
});

describe("dsw theme — composer card", () => {
  test("#webui-input is the wrapped card (22px radius, layer-2 fill, 16px)", () => {
    expect(styleBlock).toContain("#webui-input {");
    expect(styleBlock).toContain("#webui-input::placeholder { color: var(--dsw-alias-label-caption); }");
    const inputRule = styleBlock.slice(styleBlock.indexOf("#webui-input {"));
    expect(inputRule).toContain("border: 1px solid var(--dsw-alias-border-l2)");
    expect(inputRule).toContain("border-radius: 22px");
    expect(inputRule).toContain("font-size: 16px");
    expect(inputRule).toContain("caret-color: var(--dsw-alias-state-business-primary)");
  });

  test("#webui-send is the 34px round accent button with the CSS arrow glyph", () => {
    expect(styleBlock).toContain("#webui-send { width: 34px; height: 34px;");
    expect(styleBlock).toContain("border-radius: 999px");
    expect(styleBlock).toContain("background: var(--dsw-alias-button-info-fill)");
    expect(styleBlock).toContain("#webui-send::after { content: '➤'; font-size: 14px; }");
    expect(styleBlock).toContain("#webui-send:hover { background: var(--dsw-alias-button-info-hover); }");
    expect(styleBlock).toContain("#webui-send:disabled { opacity: 0.4; cursor: default; }");
  });

  test("#webui-abort is a ghost pill", () => {
    expect(styleBlock).toContain("#webui-abort { border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary);");
    expect(styleBlock).toContain("#webui-abort:hover { background: var(--dsw-alias-interactive-bg-hover); }");
  });

  test("mobile: composer stays sticky on the dsw base, input keeps 16px (iOS zoom)", () => {
    expect(styleBlock).toContain("position: sticky; bottom: 0; background: var(--dsw-alias-bg-base)");
  });
});

describe("dsw theme — panes, cards, filter bar, toast", () => {
  test("cards/report articles are layer-1 cards at 12px radius", () => {
    expect(styleBlock).toContain("background: var(--dsw-alias-bg-layer-1)");
    expect(styleBlock).toContain("border: 1px solid var(--dsw-alias-border-l1)");
    expect(styleBlock).toContain("border-radius: 12px");
  });

  test("feedback log is the dsw toast", () => {
    const logRule = styleBlock.slice(styleBlock.indexOf("#webui-feedback-log {"));
    expect(logRule).toContain("background: var(--dsw-alias-toast-bg)");
    expect(logRule).toContain("border: 1px solid var(--dsw-alias-border-l2)");
    expect(logRule).toContain("border-radius: 12px");
    expect(logRule).toContain("color: var(--dsw-alias-label-secondary)");
  });

  test("filter input is a layer-2 pill; chips are ghost pills with dsw states", () => {
    const filterRule = styleBlock.slice(styleBlock.indexOf("#feed-filter {"));
    expect(filterRule).toContain("border-radius: 999px");
    expect(filterRule).toContain("background: var(--dsw-alias-bg-layer-2)");
    const chipRule = styleBlock.slice(styleBlock.indexOf("#feed-filter-bar .chip {"));
    expect(chipRule).toContain("background: transparent");
    expect(styleBlock).toContain("#feed-filter-bar .chip.active { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }");
  });
});

describe("dsw theme — ask-user overlay cssText (JS single-quoted strings)", () => {
  test("overlay rides rgb(35,35,36) bg + rgba(255,255,255,0.12) border, no accent hexes left", () => {
    const askFn = RENDER_SHELL_HTML.slice(
      RENDER_SHELL_HTML.indexOf("function renderAskUser"),
      RENDER_SHELL_HTML.indexOf("let respondedPresent"),
    );
    expect(askFn).toContain("background:rgb(35,35,36)");
    expect(askFn).toContain("border:1px solid rgba(255,255,255,0.12)");
    expect(askFn).not.toContain("#6cf");
    expect(askFn).not.toContain("#8884");
    expect(askFn).not.toContain("#8882");
  });
});
