import { expect, test, mock } from "bun:test";
import { createPromptHistoryExtension } from "./prompt-history.ts";

test("BUN_PI_PROMPT_HISTORY=0 disables capture (no subscription)", () => {
	const prev = process.env.BUN_PI_PROMPT_HISTORY;
	process.env.BUN_PI_PROMPT_HISTORY = "0";
	try {
		const record = mock((_cwd: string, _text: string) => []);
		const extension = createPromptHistoryExtension(record);
		const handlers: any[] = [];
		const pi = { on: (_e: string, fn: any) => { handlers.push(fn); } } as any;
		extension(pi);
		expect(handlers).toHaveLength(0); // gated → no subscription
	} finally {
		if (prev === undefined) delete process.env.BUN_PI_PROMPT_HISTORY;
		else process.env.BUN_PI_PROMPT_HISTORY = prev;
	}
});

test("subscribes to input; records interactive + rpc, skips synthetic (extension) source", () => {
	const record = mock((_cwd: string, _text: string) => []);
	const extension = createPromptHistoryExtension(record);
	const handlers: Array<(e: any, ctx: any) => void> = [];
	const pi = { on: (_event: string, fn: (e: any, ctx: any) => void) => { handlers.push(fn); } } as any;
	extension(pi);
	expect(handlers).toHaveLength(1);

	handlers[0]({ type: "input", text: "hello", source: "interactive" }, { cwd: "/proj" });
	handlers[0]({ type: "input", text: "rpc-prompt", source: "rpc" }, { cwd: "/proj" });
	handlers[0]({ type: "input", text: "synthetic", source: "extension" }, { cwd: "/proj" }); // skipped

	expect(record).toHaveBeenCalledTimes(2);
	expect(record).toHaveBeenNthCalledWith(1, "/proj", "hello");
	expect(record).toHaveBeenNthCalledWith(2, "/proj", "rpc-prompt");
});
