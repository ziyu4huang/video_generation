/**
 * Unit tests for `checkToolContract` — the two unchecked tool contracts
 * (execute handler present + parameters schema constructible).
 */
import { describe, test, expect } from "bun:test";
import { Type } from "typebox";
import { checkToolContract } from "../contract.ts";

describe("checkToolContract", () => {
	test("valid tool: execute fn + constructible TypeBox schema → both true", () => {
		const def = {
			name: "t",
			description: "x",
			parameters: Type.Object({ a: Type.String() }),
			execute() {},
		};
		expect(checkToolContract(def)).toEqual({ hasExecute: true, schemaValid: true });
	});

	test("missing execute → hasExecute false; schema still valid", () => {
		const def = { name: "t", parameters: Type.Object({}) };
		const c = checkToolContract(def);
		expect(c.hasExecute).toBe(false);
		expect(c.schemaValid).toBe(true);
	});

	test("non-function execute → hasExecute false", () => {
		expect(checkToolContract({ name: "t", parameters: Type.Object({}), execute: "no" }).hasExecute).toBe(false);
	});

	test("missing parameters → schemaValid false", () => {
		expect(checkToolContract({ name: "t", execute() {} }).schemaValid).toBe(false);
	});

	test("non-object parameters (string) → schemaValid false, no throw", () => {
		expect(checkToolContract({ name: "t", execute() {}, parameters: "not-an-object" }).schemaValid).toBe(false);
	});

	test("null / undefined def → both false, no throw", () => {
		expect(checkToolContract(null)).toEqual({ hasExecute: false, schemaValid: false });
		expect(checkToolContract(undefined)).toEqual({ hasExecute: false, schemaValid: false });
	});
});
