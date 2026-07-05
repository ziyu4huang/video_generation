/**
 * PreviewBoxRenderer — renders a bordered preview box.
 * Ported from rpiv-ask-user-question view/components/preview/preview-box-renderer.ts.
 */
import { type Theme } from "@earendil-works/pi-coding-agent";

export class PreviewBoxRenderer {
	private readonly theme: Theme;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	/**
	 * Wrap content lines in a border box.
	 */
	render(content: string[], _width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		lines.push(t.fg("dim", "┌─ Preview ─────────────────────────────┐"));
		for (const line of content) {
			lines.push(t.fg("dim", `│ ${line}`));
		}
		lines.push(t.fg("dim", "└──────────────────────────────────────────┘"));
		return lines;
	}
}
