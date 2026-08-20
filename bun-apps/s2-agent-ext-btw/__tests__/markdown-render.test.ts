/**
 * Markdown rendering for the BTW overlay.
 *
 * Locks in that assistant-text is rendered through pi-tui's `Markdown`
 * component (markers parsed/consumed, text kept) instead of being dumped as
 * raw syntax (`# heading`, `**bold**`, backticks shown verbatim).
 *
 * Uses identity fake themes so assertions inspect the *parsed* text, not ANSI.
 * No TUI, no LLM, no network.
 */
import { test, expect } from "bun:test";
import { buildOverlayTranscript, wrapOverlayLines } from "../src/btw/overlay";

// Fake terminal theme: identity styling → inspect raw text.
const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	// biome-ignore lint/suspicious/noExplicitAny: test stub
} as any;

// Fake Markdown theme: identity functions. Markdown *parsing* still runs
// (so `#`, `**`, backticks are consumed), it just emits no ANSI.
const id = (t: string) => t;
const fakeMdTheme = {
	heading: id,
	link: id,
	linkUrl: id,
	code: id,
	codeBlock: id,
	codeBlockBorder: id,
	quote: id,
	quoteBorder: id,
	hr: id,
	listBullet: id,
	bold: id,
	italic: id,
	strikethrough: id,
	underline: id,
};

test("assistant-text is tagged as a markdown block carrying the raw text", () => {
	const blocks = buildOverlayTranscript(
		[{ id: 1, turnId: 1, type: "assistant-text", text: "# Title\n\n**bold**", streaming: false }],
		theme,
	);
	const md = blocks.find((b) => b.kind === "markdown");
	expect(md).toBeDefined();
	expect((md as { text: string }).text).toBe("# Title\n\n**bold**");
});

test("wrapOverlayLines renders markdown — markers consumed, text kept", () => {
	const blocks = buildOverlayTranscript(
		[{ id: 1, turnId: 1, type: "assistant-text", text: "# Heading\n\nHas **bold** and `code`.", streaming: false }],
		theme,
	);
	const joined = wrapOverlayLines(blocks, 60, fakeMdTheme).join("\n");
	expect(joined).toContain("Heading");
	expect(joined).not.toContain("# Heading");
	expect(joined).toContain("bold");
	expect(joined).not.toContain("**bold**");
	expect(joined).toContain("code");
	expect(joined).not.toContain("`code`");
});

test("non-markdown entries (user-message) wrap as plain text, no markdown block", () => {
	const blocks = buildOverlayTranscript(
		[{ id: 1, turnId: 1, type: "user-message", text: "plain user text" }],
		theme,
	);
	const joined = wrapOverlayLines(blocks, 60, fakeMdTheme).join("\n");
	expect(joined).toContain("plain user text");
	expect(blocks.every((b) => b.kind !== "markdown")).toBe(true);
});

test("empty transcript still renders its placeholder line", () => {
	const blocks = buildOverlayTranscript([], theme);
	const joined = wrapOverlayLines(blocks, 60, fakeMdTheme).join("\n");
	expect(joined).toContain("No BTW thread yet");
});
