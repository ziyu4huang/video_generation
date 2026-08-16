/** External answer channel tests (webui-present-adoption §C3): the webui shell
 *  mirror answers rpiv:ask-user:prompt via rpiv:ask-user:answer — same `done`
 *  resolution as a TUI keyboard submit; first answer wins; wrong id ignored. */
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

/** Well-formed QuestionnaireResult per tool/types.ts — the answer channel is a
 *  pass-through, so QuestionAnswer requires `kind` + `questionIndex`. */
const EXTERNAL_RESULT = {
	answers: [{ questionIndex: 0, question: "Ship it?", kind: "option" as const, answer: "Yes" }],
	cancelled: false,
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
						/* QuestionnaireSession may need a real tui — done is already captured */
					}
					return customPromise;
				},
			},
		} as never,
	};
}

describe("ask_user external answer channel", () => {
	test("prompt emit carries promptId + questions", async () => {
		const f = makeFakePi();
		registerAskUserQuestionTool(f.pi);
		const pending = capturedTool!.execute("id", PARAMS, undefined, undefined, makeCtx().ctx);
		await Bun.sleep(10);
		const prompt = f.emitted.find(([e]) => e === ASK_USER_PROMPT_EVENT)!;
		expect(prompt?.[1]?.promptId).toBeTruthy();
		expect(prompt?.[1]?.questions?.length).toBe(1);
		// race-free settle: resolve via the answer handler with the matching promptId
		f.handlers.get(ASK_USER_ANSWER_EVENT)!({ promptId: prompt[1].promptId, result: EXTERNAL_RESULT });
		await pending;
	});

	test("matching promptId resolves execute; wrong id ignored; second answer ignored", async () => {
		const f = makeFakePi();
		registerAskUserQuestionTool(f.pi);
		const { ctx } = makeCtx();
		const pending = capturedTool!.execute("id", PARAMS, undefined, undefined, ctx);
		await Bun.sleep(10);
		const prompt = f.emitted.find(([e]) => e === ASK_USER_PROMPT_EVENT)!;
		const answer = f.handlers.get(ASK_USER_ANSWER_EVENT)!;
		// wrong id first — must NOT resolve
		answer({ promptId: "wrong", result: { answers: [{ questionIndex: 0, question: "Ship it?", kind: "option" as const, answer: "No" }], cancelled: false } });
		const raced = await Promise.race([pending.then(() => "resolved"), Bun.sleep(30).then(() => "pending")]);
		expect(raced).toBe("pending");
		// matching id — resolves with the external result
		answer({ promptId: prompt[1].promptId, result: EXTERNAL_RESULT });
		// execute resolves with the ToolResult envelope ({content, details}) — not a bare string
		const res: AnyRec = await pending;
		expect(res.content?.[0]?.text).toContain("Yes");
		// second answer after resolution — ignored without throwing
		answer({ promptId: prompt[1].promptId, result: { answers: [] } });
	});
});
