/**
 * Smoke tests for the knowledge-emission bus contract (src/emit.ts).
 *
 * These verify the contract surface — publish/subscribe on the `pi:knowledge`
 * channel — using a fake ExtensionAPI. They DO NOT touch the vault; the
 * deterministic ingest path (ingest.test.ts) covers persistence. Here we only
 * assert the bus plumbing: emit → handler receives the payload, and the
 * best-effort guarantees (missing bus / throwing handler / malformed payload
 * are all swallowed and never break the emitter).
 */
import { test, expect, describe } from "bun:test";
import {
	emitKnowledge,
	onKnowledge,
	KNOWLEDGE_CHANNEL,
	type KnowledgeEmission,
} from "../src/emit.ts";

/** Minimal fake ExtensionAPI exposing only `events` (the EventBus shape). */
function fakeApi(handlers: Record<string, ((data: unknown) => void)[]> = {}) {
	const subs = handlers;
	return {
		events: {
			emit(channel: string, data: unknown) {
				for (const h of subs[channel] ?? []) h(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				(subs[channel] ??= []).push(handler);
				return () => {
					subs[channel] = (subs[channel] ?? []).filter((h) => h !== handler);
				};
			},
		},
	};
}

const sampleEmission: KnowledgeEmission = {
	source: "workflow-jsonl",
	sourceLabel: "flux2:live-e2e",
	records: [
		{
			id: "flux2:argv-injection",
			type: "gotcha",
			title: "Reject leading-dash argv",
			detail: "x",
			tags: ["argv"],
			dimension: null,
			confidence: 0.9,
			status: "active",
			superseded_by: null,
		},
	],
};

describe("emitKnowledge / onKnowledge", () => {
	test("a subscribed handler receives the emitted payload", () => {
		const api = fakeApi();
		let received: KnowledgeEmission | null = null;
		onKnowledge(api as never, (p) => (received = p));
		emitKnowledge(api as never, sampleEmission);
		expect(received).not.toBeNull();
		expect(received!.sourceLabel).toBe("flux2:live-e2e");
		expect(received!.records?.[0]!.id).toBe("flux2:argv-injection");
	});

	test("unsubscribe stops delivery", () => {
		const api = fakeApi();
		let count = 0;
		const off = onKnowledge(api as never, () => count++);
		emitKnowledge(api as never, sampleEmission);
		off();
		emitKnowledge(api as never, sampleEmission);
		expect(count).toBe(1);
	});

	test("channel name is the documented contract", () => {
		expect(KNOWLEDGE_CHANNEL).toBe("pi:knowledge");
	});
});

const dirEmission: KnowledgeEmission = {
	source: "generic",
	sourceLabel: "file2md:my-doc",
	dir: "/abs/vlm-out/my-doc",
};

describe("onKnowledge — dir payload (file2md convergence)", () => {
	test("a dir-only payload is delivered (gate accepts dir)", () => {
		const api = fakeApi();
		let received: KnowledgeEmission | null = null;
		onKnowledge(api as never, (p) => (received = p));
		emitKnowledge(api as never, dirEmission);
		expect(received).not.toBeNull();
		expect(received!.dir).toBe("/abs/vlm-out/my-doc");
		expect(received!.source).toBe("generic");
	});

	test("gate skips a payload with none of records/kbFile/dir", () => {
		const api = fakeApi();
		let seen = 0;
		onKnowledge(api as never, () => seen++);
		// well-typed except it carries no records/kbFile/dir → must be skipped
		(api.events as { emit: (c: string, d: unknown) => void }).emit(KNOWLEDGE_CHANNEL, {
			source: "generic",
			sourceLabel: "x",
			note: "nothing to ingest",
		});
		expect(seen).toBe(0);
	});
});

describe("emitKnowledge — best-effort guarantees", () => {
	test("missing events bus → no-op, no throw", () => {
		const api = { events: undefined } as never;
		expect(() => emitKnowledge(api, sampleEmission)).not.toThrow();
	});

	test("throwing emit → swallowed, no throw", () => {
		const api = { events: { emit: () => { throw new Error("boom"); } } } as never;
		expect(() => emitKnowledge(api, sampleEmission)).not.toThrow();
	});

	test("onKnowledge with no bus → returns a no-op unsubscribe", () => {
		const api = { events: undefined } as never;
		const off = onKnowledge(api as never, () => {});
		expect(typeof off).toBe("function");
		expect(() => off()).not.toThrow();
	});

	test("handler skips malformed payloads (missing source/sourceLabel)", () => {
		const api = fakeApi();
		let seen = 0;
		// Bypass emitKnowledge to feed raw malformed data directly through the bus.
		(api.events as { emit: (c: string, d: unknown) => void }).emit(KNOWLEDGE_CHANNEL, {
			records: [],
		});
		onKnowledge(api as never, () => seen++);
		// Drive a well-formed + a malformed payload.
		(api.events as { emit: (c: string, d: unknown) => void }).emit(KNOWLEDGE_CHANNEL, sampleEmission);
		(api.events as { emit: (c: string, d: unknown) => void }).emit(KNOWLEDGE_CHANNEL, { source: "x" });
		expect(seen).toBe(1); // only the well-formed emission delivered
	});
});
