/**
 * RPC / dialog-primitive fallback for ask_user_question.
 * Ported from rpiv-ask-user-question rpc-fallback.ts.
 *
 * Stripped of @juicesharp/rpiv-i18n — English inline fallbacks.
 */
import { displayLabel } from "./state/i18n-bridge.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./tool/types.js";

const MULTI_SELECT_INSTRUCTIONS =
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";

const MAX_PREVIEW_CHARS = 600;

export type DialogUI = {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

export function hasDialogUI(ui: unknown): ui is DialogUI {
	const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
	return typeof u?.select === "function" && typeof u?.input === "function";
}

type Option = QuestionData["options"][number];

function formatOptionLine(option: Option, index: number): string {
	return `${index + 1}. ${option.label} — ${option.description}`;
}

function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return i >= 0 && i < count ? i : null;
}

function buildPreviewBlock(question: QuestionData): string {
	const blocks = question.options.flatMap((o, i) =>
		o.preview && o.preview.length > 0
			? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
			: [],
	);
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

export async function runRpcQuestionnaire(ui: DialogUI, params: QuestionParams): Promise<QuestionnaireResult> {
	const answers: QuestionAnswer[] = [];
	for (let qi = 0; qi < params.questions.length; qi++) {
		const q = params.questions[qi];
		const header = q.header ? `[${q.header}] ` : "";
		const answer = q.multiSelect ? await askMultiSelect(ui, q, qi, header) : await askSingleSelect(ui, q, qi, header);
		if (answer === undefined) return { answers, cancelled: true };
		answers.push(answer);
	}
	return { answers, cancelled: false };
}

async function askSingleSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
): Promise<QuestionAnswer | undefined> {
	const options = q.options.map(formatOptionLine);
	options.push(`${q.options.length + 1}. ${displayLabel("other")}`);
	const chosen = await ui.select(`${header}${q.question}${buildPreviewBlock(q)}`, options);
	if (chosen == null) return undefined;
	const idx = parseIndex(chosen, options.length);
	if (idx == null) return undefined;
	if (idx < q.options.length) {
		const o = q.options[idx];
		return {
			questionIndex,
			question: q.question,
			kind: "option",
			answer: o.label,
			preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
		};
	}
	const typed = await ui.input(`${header}${q.question}\n\n${CUSTOM_ANSWER_TITLE}`, "");
	if (typed == null) return undefined;
	return { questionIndex, question: q.question, kind: "custom", answer: typed };
}

async function askMultiSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
): Promise<QuestionAnswer | undefined> {
	const list = q.options.map(formatOptionLine).join("\n");
	const value = await ui.input(
		`${header}${q.question}\n\n${list}\n\n${MULTI_SELECT_INSTRUCTIONS}`,
		MULTI_SELECT_PLACEHOLDER,
	);
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
	}
	const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
	const indices = tokens.map((tok) => (/^\d+\.?$/.test(tok) ? parseIndex(tok, q.options.length) : null));
	if (indices.every((i): i is number => i != null)) {
		const selected: string[] = [];
		for (const i of indices) {
			const label = q.options[i].label;
			if (!selected.includes(label)) selected.push(label);
		}
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected };
	}
	return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
}
