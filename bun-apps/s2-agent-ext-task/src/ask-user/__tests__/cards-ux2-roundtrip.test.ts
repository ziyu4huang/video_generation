/** cards-ux2 01 repro: the round-trip through the EXACT sender payloads the
 *  webui render-shell posts. L515 (ask CARD) sends proper QuestionnaireResult
 *  rows; L737 (ask dialog) sends a bare {question, answer} map. Whichever
 *  breaks here IS the bug (canonical = the card/L515 row shape). */
import { describe, expect, test } from "bun:test";
import { registerAskUserQuestionTool } from "../ask-user-question.js";
import { ASK_USER_ANSWER_EVENT, ASK_USER_PROMPT_EVENT } from "../events.js";

type AnyRec = Record<string, any>;

function makeFakePi() {
	const emitted: Array<[string, AnyRec]> = [];
	const handlers = new Map<string, (p: unknown) => void>();
	return {
		pi: {
			events: {
				emit: (event: string, payload: AnyRec) => void emitted.push([event, payload]),
				on: (event: string, handler: (p: unknown) => void) => {
					handlers.set(event, handler);
					return () => void handlers.delete(event);
				},
			},
			registerTool: (tool: AnyRec) => void (capturedTool = tool),
		} as never,
		emitted,
		handlers,
	};
}
let capturedTool: AnyRec | undefined;

const PARAMS = {
	questions: [
		{
			question: "Ship it?",
			header: "Release",
			options: [
				{ label: "Yes", description: "merge now" },
				{ label: "No", description: "hold" },
			],
		},
	],
};

function makeCtx() {
	let settleCustom: (v: unknown) => void;
	const customPromise = new Promise<unknown>((res) => void (settleCustom = res));
	return {
		ctx: {
			hasUI: true,
			ui: {
				custom: (mount: (...a: any[]) => unknown) => {
					try {
						mount({}, {}, {}, (r: unknown) => settleCustom(r));
					} catch {
						/* done already captured */
					}
					return customPromise;
				},
			},
		} as never,
	};
}

/** EXACT render-shell.ts L515 payload (ask CARD submit, t05): proper rows. */
const CARD_L515_RESULT = {
	cancelled: false,
	answers: [
		{ questionIndex: 0, question: "Ship it?", kind: "option" as const, answer: "Yes" },
	],
};

/** render-shell.ts L737 payload AFTER the cards-ux2 01 fix: the dialog now
 *  emits the SAME canonical row shape as the card submit (the legacy bare
 *  {question, answer} map lacked kind/questionIndex, so formatQuestionAnswer
 *  fell through its switch and the tool result literally read "undefined" —
 *  the repro'd bug; fixed at the sender, canonical = card/L515 row shape). */
const DIALOG_L737_RESULT = {
	cancelled: false,
	answers: [
		{ questionIndex: 0, question: "Ship it?", kind: "option" as const, answer: "Yes" },
	],
};

async function runRoundtrip(result: unknown) {
	const f = makeFakePi();
	registerAskUserQuestionTool(f.pi);
	const pending = capturedTool!.execute("id", PARAMS, undefined, undefined, makeCtx().ctx);
	await Bun.sleep(10);
	const prompt = f.emitted.find(([e]) => e === ASK_USER_PROMPT_EVENT)!;
	f.handlers.get(ASK_USER_ANSWER_EVENT)!({ promptId: prompt[1].promptId, result });
	const res: AnyRec = await pending;
	return res;
}

describe("cards-ux2 01 — webui sender payload round-trips", () => {
	test("L515 ask-card payload: execute resolves the answers (canonical shape)", async () => {
		const res = await runRoundtrip(CARD_L515_RESULT);
		// the orchestrator-visible tool result must carry the answer — not
		// "undefined" (the observed bug) and not a cancel envelope.
		expect(res.content?.[0]?.text).toContain("Ship it?");
		expect(res.content?.[0]?.text).toContain("Yes");
		expect(res.content?.[0]?.text).not.toContain("undefined");
		expect(res.details?.cancelled).toBe(false);
		expect(res.details?.answers?.[0]?.answer).toBe("Yes");
	});

	test("L737 ask-dialog payload: execute resolves the answers too", async () => {
		const res = await runRoundtrip(DIALOG_L737_RESULT);
		expect(res.content?.[0]?.text).toContain("Ship it?");
		expect(res.content?.[0]?.text).toContain("Yes");
		expect(res.content?.[0]?.text).not.toContain("undefined");
		expect(res.details?.cancelled).toBe(false);
		expect(res.details?.answers?.[0]?.answer).toBe("Yes");
	});
});
