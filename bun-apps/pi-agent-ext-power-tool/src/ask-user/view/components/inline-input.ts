/**
 * Shared inline-input row renderer for wrapping-select.
 * Ported from rpiv-ask-user-question view/components/inline-input.ts.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

export interface InlineInputRenderOptions {
	buffer: string;
	cursorOffset: number | undefined;
	rowPrefix: string;
	continuationPrefix: string;
	contentWidth: number;
	selectedText: (text: string) => string;
	multiline: boolean;
}

/**
 * Shared inline-input row renderer.
 *
 * When `multiline === false` (multi-select Other-row target), cursor and buffer
 * right-trim to a single line; the continuation prefix is not drawn (no text
 * overflow into the description gutter since there is no description).
 *
 * When `multiline === true` (single-select inline input), all content-width
 * lines are rendered with the continuation prefix and cursor marking on every
 * line — the cursor visual is always in the last rendered line, and the
 * per-line cursor trace (│) fires for every wrapped line.
 */
export function renderInlineInputRow(options: InlineInputRenderOptions): string[] {
	const { buffer, cursorOffset, rowPrefix, continuationPrefix, contentWidth, selectedText, multiline } = options;

	// Single-line mode: right‑trim the buffer to one line.
	const effective = multiline ? buffer : buffer.split("\n")[0] ?? "";
	const cursor = cursorOffset ?? effective.length;

	if (effective.length === 0) {
		const prompt = "▌";
		return multiline
			? [`${rowPrefix}${selectedText(prompt)}`]
			: [`${rowPrefix}${selectedText(prompt)}`];
	}

	if (contentWidth <= 0) return [`${rowPrefix}${selectedText("…")}`];

	if (!multiline) {
		// Single-line — no wrap, no continuation prefix.
		const trimmed = effective.length > contentWidth ? effective.slice(0, contentWidth - 1) + "…" : effective;
		return [`${rowPrefix}${selectedText(trimmed)}`];
	}

	// Multi-line: wrap and render.
	const lines: string[] = [];
	let remaining = effective;
	let lineStart = 0;

	while (remaining.length > 0) {
		const segment = remaining.length > contentWidth ? remaining.slice(0, contentWidth) : remaining;
		const prefix = lineStart === 0 ? rowPrefix : continuationPrefix;
		const cursorOnThisLine =
			cursor >= lineStart && cursor <= lineStart + segment.length;
		const display = cursorOnThisLine ? insertCursor(segment, cursor - lineStart) : segment;
		lines.push(`${prefix}${selectedText(display)}`);
		remaining = remaining.length > contentWidth ? remaining.slice(contentWidth) : "";
		lineStart += contentWidth;
	}

	return lines;
}

/**
 * Insert a cursor marker `▌` at position `offset` within `segment`.
 * When offset === segment.length, the cursor is at the end.
 */
function insertCursor(segment: string, offset: number): string {
	offset = Math.max(0, Math.min(offset, segment.length));
	// visibleWidth of each char matters for CJK.
	let visIdx = 0;
	let strIdx = 0;
	while (strIdx < segment.length && visIdx < offset) {
		const ch = segment[strIdx]!;
		visIdx += visibleWidth(ch) > 1 ? 2 : 1;
		strIdx++;
	}
	return segment.slice(0, strIdx) + "▌" + segment.slice(strIdx);
}
