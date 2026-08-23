/**
 * PreviewBlockRenderer — renders a markdown preview block for a single option.
 * Ported from rpiv-ask-user-question view/components/preview/preview-block-renderer.ts.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuestionData } from "../../../tool/types.js";

interface PreviewBlockConfig {
	question: QuestionData;
	theme: Theme;
	markdownTheme: Record<string, (text: string) => string>;
}

export class PreviewBlockRenderer {
	private readonly config: PreviewBlockConfig;

	constructor(config: PreviewBlockConfig) {
		this.config = config;
	}

	/**
	 * Render the preview content for a single option as markdown text.
	 * Returns the rendered lines, or empty array if no preview content.
	 */
	render(optionIndex: number, width: number): string[] {
		const option = this.config.question.options[optionIndex];
		if (!option?.preview || option.preview.length === 0) return [];

		const t = this.config.theme;
		const lines: string[] = [];

		// Header
		lines.push(t.bold(`Preview: ${option.label}`));
		lines.push("");

		// Monospace-verbatim preview (CC parity): code and ASCII mockups must not
		// re-wrap. Full markdown rendering is deliberately out of scope.
		const clip = (line: string): string => (line.length > width ? line.slice(0, width) : line);
		for (const line of option.preview.split("\n")) {
			lines.push(clip(line));
		}

		return lines.map((l) => t.fg("dim", l));
	}
}
