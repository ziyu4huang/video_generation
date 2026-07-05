/**
 * QuestionnairePropsAdapter — drives every component setter from canonical state.
 * Ported from rpiv-ask-user-question view/props-adapter.ts.
 */
import type { Input } from "@earendil-works/pi-tui";
import type { BindingContext, PerTabBindingContext } from "../state/selectors/contract.js";
import { selectActivePreviewPaneIndex } from "../state/selectors/derivations.js";
import { selectActiveView } from "../state/selectors/focus.js";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { BoundGlobalBinding, BoundPerTabBinding } from "./component-binding.js";
import type { WrappingSelectItem } from "./components/wrapping-select.js";
import type { TabComponents } from "./tab-components.js";

interface Invalidatable {
	invalidate(): void;
}

function getInputCursorOffset(input: Input): number | undefined {
	const raw = (input as unknown as { cursor?: unknown }).cursor;
	if (typeof raw !== "number") return undefined;
	if (!Number.isSafeInteger(raw)) return undefined;
	const value = input.getValue();
	if (raw < 0 || raw > value.length) return undefined;
	return raw;
}

export interface QuestionnairePropsAdapterConfig {
	tui: { requestRender(): void };
	questions: readonly QuestionData[];
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	tabsByIndex: ReadonlyArray<TabComponents>;
	inlineInput: Input;
	globalBindings: ReadonlyArray<BoundGlobalBinding>;
	perTabBindings: ReadonlyArray<BoundPerTabBinding>;
	extraInvalidatables?: ReadonlyArray<Invalidatable>;
}

export class QuestionnairePropsAdapter {
	private readonly tui: QuestionnairePropsAdapterConfig["tui"];
	private readonly questions: readonly QuestionData[];
	private readonly itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>;
	private readonly tabsByIndex: ReadonlyArray<TabComponents>;
	private readonly inlineInput: Input;
	private readonly globalBindings: ReadonlyArray<BoundGlobalBinding>;
	private readonly perTabBindings: ReadonlyArray<BoundPerTabBinding>;
	private readonly extraInvalidatables: ReadonlyArray<Invalidatable>;

	constructor(config: QuestionnairePropsAdapterConfig) {
		this.tui = config.tui;
		this.questions = config.questions;
		this.itemsByTab = config.itemsByTab;
		this.tabsByIndex = config.tabsByIndex;
		this.inlineInput = config.inlineInput;
		this.globalBindings = config.globalBindings;
		this.perTabBindings = config.perTabBindings;
		this.extraInvalidatables = config.extraInvalidatables ?? [];
	}

	apply(state: QuestionnaireState): void {
		const totalQuestions = this.questions.length;
		const paneIndex = selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
		const activePreviewPane = this.tabsByIndex[paneIndex]?.preview ?? this.tabsByIndex[0]!.preview;

		const ctx: BindingContext = {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			tabsByIndex: this.tabsByIndex,
			paneIndex,
			inputBuffer: this.inlineInput.getValue(),
		};

		for (const binding of this.globalBindings) {
			binding.apply(state, ctx);
		}

		for (let i = 0; i < totalQuestions; i++) {
			const tab = this.tabsByIndex[i];
			if (!tab) continue;
			const perTabCtx: PerTabBindingContext = {
				...ctx,
				tab,
				i,
				totalQuestions,
			};
			for (const binding of this.perTabBindings) {
				binding.apply(state, perTabCtx);
			}
		}

		this.tui.requestRender();
	}

	invalidate(): void {
		for (const binding of this.globalBindings) binding.invalidate();
		for (const tab of this.tabsByIndex) {
			tab.optionList.invalidate();
			tab.preview.invalidate();
			tab.multiSelect?.invalidate();
		}
		for (const inv of this.extraInvalidatables) inv.invalidate();
	}
}
