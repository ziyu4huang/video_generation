import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { buildMainSpec, parseWorkflowArgs } from "../src/commands/workflow.ts";
import type { ParsedArgs } from "../src/args.ts";

function args(partial: Partial<ParsedArgs>): ParsedArgs {
	// Only model/provider matter for buildMainSpec; spread a minimal base.
	return { verbose: 0, positionals: [], json: false, ...partial } as ParsedArgs;
}

describe("buildMainSpec — provider/model composition", () => {
	it("returns undefined when no model is set", () => {
		assert.equal(buildMainSpec(args({})), undefined);
	});
	it("keeps an already-qualified model (contains '/') verbatim", () => {
		assert.equal(buildMainSpec(args({ model: "lm-studio/google/gemma-4-26b-a4b-qat" })), "lm-studio/google/gemma-4-26b-a4b-qat");
	});
	it("prefixes provider when model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-26b", provider: "lm-studio" })), "lm-studio/gemma-4-26b");
	});
	it("returns the bare model when provider is absent and model has no '/'", () => {
		assert.equal(buildMainSpec(args({ model: "gemma-4-26b" })), "gemma-4-26b");
	});
});

describe("parseWorkflowArgs — JSON parsing", () => {
	it("returns undefined for undefined / empty input", () => {
		assert.equal(parseWorkflowArgs(undefined), undefined);
		assert.equal(parseWorkflowArgs(""), undefined);
	});
	it("parses valid JSON", () => {
		assert.deepEqual(parseWorkflowArgs('{"a":1}'), { a: 1 });
	});
	it("throws a clear, prefixed error on bad JSON (not an opaque parse error)", () => {
		assert.throws(() => parseWorkflowArgs("{not json}"), /workflow: --args must be valid JSON/);
	});
});
