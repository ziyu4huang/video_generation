import { describe, expect, test } from "bun:test";
import deployExtension from "./index.ts";

describe("deploy extension factory", () => {
	test("registers exactly pi_deploy and pi_verify", () => {
		const tools: { name: string }[] = [];
		const api: any = {
			registerTool: (def: any) => tools.push(def),
		};
		deployExtension(api);
		expect(tools.map((t) => t.name).sort()).toEqual(["pi_deploy", "pi_verify"]);
	});
});
