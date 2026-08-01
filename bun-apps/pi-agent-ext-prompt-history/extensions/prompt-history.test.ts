import { expect, test, mock } from "bun:test";
import { createPromptHistoryExtension } from "./prompt-history.ts";

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
