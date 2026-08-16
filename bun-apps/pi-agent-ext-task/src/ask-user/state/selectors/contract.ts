import type { QuestionnaireState } from "../state.js";
import type { TabComponents } from "../../view/tab-components.js";
import type { QuestionData } from "../../tool/types.js";

export interface BindingContext {
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly unknown[]>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	paneIndex: number;
	inputBuffer: string;
}

export interface PerTabBindingContext extends BindingContext {
	tab: TabComponents;
	i: number;
	totalQuestions: number;
}

export type GlobalSelector<P> = (state: QuestionnaireState, ctx: BindingContext) => P;
export type PerTabSelector<P> = (state: QuestionnaireState, ctx: PerTabBindingContext) => P;
