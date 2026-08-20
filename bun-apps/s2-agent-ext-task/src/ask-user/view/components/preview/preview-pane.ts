/**
 * PreviewPane — side-by-side preview pane for options with preview content.
 * Ported from rpiv-ask-user-question view/components/preview/preview-pane.ts.
 */
import type { QuestionData } from "../../../tool/types.js";
import type { StatefulView } from "../../stateful-view.js";
import { OptionListView } from "../option-list-view.js";
import { PreviewBlockRenderer } from "./preview-block-renderer.js";
import { leftPaneWidth, decideLayout, type LayoutKind } from "./preview-layout-decider.js";

export interface PreviewPaneProps {
	visible: boolean;
	optionIndex: number;
	focused: boolean;
}

export class PreviewPane implements StatefulView<PreviewPaneProps> {
	private readonly question: QuestionData;
	private readonly getTerminalWidth: () => number;
	private readonly optionListView: OptionListView;
	private readonly previewBlock: PreviewBlockRenderer;
	private props: PreviewPaneProps = { visible: true, optionIndex: 0, focused: false };
	private globalLeftWidth: ((paneWidth: number) => number) | undefined;

	constructor(options: {
		question: QuestionData;
		getTerminalWidth: () => number;
		optionListView: OptionListView;
		previewBlock: PreviewBlockRenderer;
	}) {
		this.question = options.question;
		this.getTerminalWidth = options.getTerminalWidth;
		this.optionListView = options.optionListView;
		this.previewBlock = options.previewBlock;
	}

	setGlobalLeftWidth(fn: (paneWidth: number) => number): void {
		this.globalLeftWidth = fn;
	}

	setProps(props: PreviewPaneProps): void {
		this.props = props;
	}

	render(width: number): string[] {
		if (!this.props.visible) return [];

		const layout: LayoutKind = this.question.multiSelect
			? "stacked"
			: decideLayout(width, this.hasPreviewContent());

		if (layout === "stacked") {
			const optionRendered = this.optionListView.render(width);
			const previewRendered = this.renderPreviewContent(width);
			return [...optionRendered, ...previewRendered];
		}

		// Side-by-side
		const leftW = this.globalLeftWidth?.(width) ?? leftPaneWidth(width);
		const rightW = Math.max(10, width - leftW - 1);
		const leftLines = this.optionListView.render(leftW);
		const rightLines = this.renderPreviewContent(rightW);
		const maxLen = Math.max(leftLines.length, rightLines.length);
		const out: string[] = [];
		for (let i = 0; i < maxLen; i++) {
			const left = leftLines[i] ?? "";
			const right = rightLines[i] ?? "";
			out.push(`${left.padEnd(leftW)}│${right}`);
		}
		return out;
	}

	naturalHeight(width: number): number {
		const layout = decideLayout(width, this.hasPreviewContent());
		if (layout === "stacked") {
			return this.optionListView.render(width).length + this.previewLines(width).length;
		}
		const leftW = this.globalLeftWidth?.(width) ?? leftPaneWidth(width);
		const rightW = Math.max(10, width - leftW - 1);
		return Math.max(this.optionListView.render(leftW).length, this.previewLines(rightW).length);
	}

	maxNaturalHeight(width: number): number {
		return this.naturalHeight(width);
	}

	invalidate(): void {}

	private hasPreviewContent(): boolean {
		return this.question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
	}

	private renderPreviewContent(width: number): string[] {
		return this.previewBlock.render(this.props.optionIndex, width);
	}

	private previewLines(width: number): string[] {
		return this.previewBlock.render(this.props.optionIndex, width);
	}
}
