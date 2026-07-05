/**
 * Tab content strategy — determines what to render in the dialog body.
 * Ported from rpiv-ask-user-question view/tab-content-strategy.ts.
 */
import { type Component } from "@earendil-works/pi-tui";
import type { StatefulView } from "./stateful-view.js";

/**
 * Strategy-pattern interface for tab body content.
 */
export interface TabContentStrategy {
	renderBody(width: number): string[];
	tabHeader?: string;
}

export class QuestionTabStrategy implements TabContentStrategy {
	private readonly questionBody: Component;

	constructor(questionBody: Component) {
		this.questionBody = questionBody;
	}

	renderBody(width: number): string[] {
		return this.questionBody.render(width);
	}
}

export class SubmitTabStrategy implements TabContentStrategy {
	private readonly submitBody: Component;

	constructor(submitBody: Component) {
		this.submitBody = submitBody;
	}

	renderBody(width: number): string[] {
		return this.submitBody.render(width);
	}
}
