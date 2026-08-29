/**
 * src/emit.ts — knowledge-emission contract for the unified extension interface.
 *
 * Two surfaces converge structured knowledge into the shared graph; this module
 * defines the IN-SESSION (runtime) surface. The other surface — the deterministic
 * workflow-layer `publishKnowledge` step that shells out to `zk-ingest` after
 * `extractKnowledge` writes a `.knowledge.jsonl` — lives in
 * `.claude/workflows/_shared-patterns.md`.
 *
 * ## Why a bus channel at all?
 *
 * `ExtensionAPI.events` (the SDK's `EventBus`) is wired into every pi session
 * but, before this module, NOTHING in the repo used it. It is the natural
 * publish/subscribe channel for runtime extensions: a content extension that
 * learns something DURING a session (e.g. a tool notices a recurring
 * user-correction pattern) can emit a knowledge record without knowing whether
 * a sink is attached. A sink (bundled alongside pi-knowledge-card, or a future
 * "knowledge publisher" extension) subscribes and forwards records to the
 * convergence vault via `ingestRecords`.
 *
 * The channel is deliberately payload-only: it never performs I/O itself, so
 * emitters can fire it unconditionally without worrying about vault state. The
 * sink decides whether + how to persist.
 *
 * ## Contract
 *
 * Channel name: `pi:knowledge` (exported as `KNOWLEDGE_CHANNEL`).
 * Payload shape: `KnowledgeEmission` (see below). Unknown fields are tolerated
 * by sinks (forwarded as-is to `ingestRecords`, which coerces defaults).
 *
 *   import { emitKnowledge } from "@repo/s2-agent-ext-knowledge-card/src/emit.ts"
 *   emitKnowledge(pi, {
 *     source: "workflow-jsonl",
 *     sourceLabel: "flux2:live-e2e",
 *     records: [{ id: "flux2:argv-injection", type: "gotcha", title: "...", ... }],
 *   })
 *
 * Best-effort by design: a missing `pi.events` (older SDK) or a throwing
 * handler must never break the emitting extension. Both `emitKnowledge` and
 * `onKnowledge` swallow their own setup errors and return no-ops on failure.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnowledgeRecord, SourceFamily } from "./types.ts";

/** The bus channel every knowledge emitter + sink agrees on. */
export const KNOWLEDGE_CHANNEL = "pi:knowledge";

/** Payload published on {@link KNOWLEDGE_CHANNEL}. Either inline `records`
 *  (runtime-emitted) OR a `kbFile` path (let the sink parse the jsonl). */
export interface KnowledgeEmission {
	source: SourceFamily;
	sourceLabel: string;
	/** Inline records (preferred for runtime emissions — small, atomic). */
	records?: KnowledgeRecord[];
	/** Path to a .knowledge.jsonl the sink should parse (preferred when an
	 *  emitter already wrote one to disk, e.g. extractKnowledge). */
	kbFile?: string;
	/** Absolute path to a directory of source files to ingest (e.g. file2md's
	 *  ./vlm-out/<slug>/ output). The sink expands it via the source family's
	 *  adapter (generic → adaptGenericMarkdown per .md). Preferred when an
	 *  emitter writes a folder rather than a .knowledge.jsonl. */
	dir?: string;
	/** Free-form note (e.g. the run-id / session-id) — sinks pass through. */
	note?: string;
}

/**
 * Publish a knowledge emission on the bus. Best-effort + non-throwing: if the
 * SDK has no `events` bus (or `emit` throws), the call is a no-op. Emitters
 * should NOT await or branch on this — fire-and-forget.
 */
export function emitKnowledge(pi: ExtensionAPI, payload: KnowledgeEmission): void {
	const bus = (pi as { events?: { emit?: (c: string, d: unknown) => void } }).events;
	if (!bus || typeof bus.emit !== "function") return;
	try {
		bus.emit(KNOWLEDGE_CHANNEL, payload);
	} catch {
		// A throwing sink/emit must never break the emitter. Swallow.
	}
}

/**
 * Usage-report payload (ticket 11, source iii): a workflow that already
 * knows a card was used (e.g. from its own receipts) reports it on the same
 * channel. Routed by SHAPE, not a kind field: `Array.isArray(used)` — so
 * legacy publish payloads (records/kbFile/dir only) keep their exact
 * contract, and legacy sinks that filter on those fields never see used
 * reports. `KnowledgeEmission` is the union of both shapes.
 */
export interface KnowledgeUsedPayload {
	source: "usage";
	sourceLabel: string;
	/** Card record ids reported used. */
	used: { uri: string }[];
	/** The provenance the reporter observed (free-form, ledger `via` is
	 *  normalized to "bus" by the sink). */
	via?: string;
	note?: string;
}

/** All payload shapes carried on {@link KNOWLEDGE_CHANNEL}. */
export type KnowledgeChannelPayload = KnowledgeEmission | KnowledgeUsedPayload;

/** Is this payload a usage report (vs a publish emission)? */
export function isKnowledgeUsed(p: Partial<KnowledgeChannelPayload>): p is KnowledgeUsedPayload {
	return (p as Partial<KnowledgeUsedPayload>).source === "usage" && Array.isArray((p as Partial<KnowledgeUsedPayload>).used);
}

/**
 * Publish a usage report on the bus. Same best-effort + non-throwing contract
 * as {@link emitKnowledge} — fire-and-forget.
 */
export function emitKnowledgeUsed(pi: ExtensionAPI, payload: KnowledgeUsedPayload): void {
	const bus = (pi as { events?: { emit?: (c: string, d: unknown) => void } }).events;
	if (!bus || typeof bus.emit !== "function") return;
	try {
		bus.emit(KNOWLEDGE_CHANNEL, payload);
	} catch {
		// never break the emitter
	}
}

/**
 * Subscribe to usage reports. Returns an unsubscribe fn (or a no-op). Only
 * shape-valid used payloads are forwarded; publish emissions are invisible to
 * this handler (the mirror image of onKnowledge's filter).
 */
export function onKnowledgeUsed(
	pi: ExtensionAPI,
	handler: (payload: KnowledgeUsedPayload) => void,
): () => void {
	const bus = (pi as { events?: { on?: (c: string, h: (d: unknown) => void) => () => void } })
		.events;
	if (!bus || typeof bus.on !== "function") return () => {};
	try {
		return bus.on(KNOWLEDGE_CHANNEL, (data: unknown) => {
			if (!data || typeof data !== "object") return;
			const p = data as Partial<KnowledgeChannelPayload>;
			if (!isKnowledgeUsed(p)) return;
			handler(p);
		});
	} catch {
		return () => {};
	}
}

/**
 * Subscribe to knowledge emissions. Returns an unsubscribe fn (or a no-op if
 * the bus is unavailable). Handlers receive the parsed {@link KnowledgeEmission};
 * malformed payloads are skipped (not forwarded) so sinks can assume shape.
 */
export function onKnowledge(
	pi: ExtensionAPI,
	handler: (payload: KnowledgeEmission) => void,
): () => void {
	const bus = (pi as { events?: { on?: (c: string, h: (d: unknown) => void) => () => void } })
		.events;
	if (!bus || typeof bus.on !== "function") return () => {};
	try {
		return bus.on(KNOWLEDGE_CHANNEL, (data: unknown) => {
			if (!data || typeof data !== "object") return;
			const p = data as Partial<KnowledgeEmission>;
			if (typeof p.source !== "string" || typeof p.sourceLabel !== "string") return;
			if (!p.records && !p.kbFile && !p.dir) return;
			return handler(p as KnowledgeEmission);
		});
	} catch {
		return () => {};
	}
}
