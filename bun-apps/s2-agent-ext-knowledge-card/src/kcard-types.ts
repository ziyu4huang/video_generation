/**
 * src/kcard-types.ts — D17 CARD_TYPES registry (ticket 06; OpenViking memory
 * types as DATA, kcard edition). One declarative entry per card type:
 * operation mode (`add_only` → never merge/delete toward the same knowledge;
 * `upsert` → MERGE_OPS path), required record fields, per-field merge-op
 * overrides, staging hint, tier-ladder rendering hint, and the extraction
 * guidance the extract loop's LLM contract embeds. No YAML/plugin layer — the
 * YAML registry exists for third-party extension; a single version-controlled
 * repo typechecks instead (D17).
 *
 * The type values mirror card frontmatter `record_type` 1:1 (D15); the index
 * `card.kind` column mirrors this same vocabulary (D9/D18).
 */
import type { MergeOp } from "./card-format.ts";

/** D16 union: the 7 legacy kcard values + the 3 ported OpenViking types. */
export type CardType =
	| "lever"
	| "avoid"
	| "pattern"
	| "gotcha"
	| "metric"
	| "false_positive"
	| "experience"
	| "event"
	| "case"
	| "preference";

/** add_only: extraction always creates; no merge/delete toward an existing
 *  card of this type (OpenViking `events` passthrough, measured). upsert:
 *  MERGE_OPS path (per-field first-wins/replace/sum/union). */
export type OperationMode = "add_only" | "upsert";

export interface CardTypeDef {
	operationMode: OperationMode;
	/** KnowledgeRecord keys the extractor must fill before converge. */
	requiredFields: readonly string[];
	/** Per-field merge-op overrides on top of MERGE_OPS (absent → table default). */
	mergeOps?: Readonly<Partial<Record<string, MergeOp>>>;
	/** OpenViking `stage` — kcard's staging hint, metadata only. */
	stage: "user" | "agent";
	/** Tier-ladder rendering hint (D17). */
	tierHint?: string;
	/** Extraction guidance surfaced in the extract-loop LLM prompt. */
	notes?: string;
}

const LEGACY_TYPES: CardType[] = [
	"lever",
	"avoid",
	"pattern",
	"gotcha",
	"metric",
	"false_positive",
	"experience",
];

/** D17: the registry. Every card type in the vault vocabulary has an entry;
 *  the extract loop validates extracted types against the key set. */
export const CARD_TYPES: Readonly<Record<CardType, CardTypeDef>> = {
	// ── Legacy (upsert; the pre-ticket-06 default path) ────────────────────
	lever: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A lever: a high-leverage move or tool that reliably pays off. Keep the concrete trigger + payoff.",
	},
	avoid: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "An avoid: a pitfall, footgun, or anti-pattern to NOT do. Keep the symptom + the failure mode.",
	},
	pattern: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A pattern: a recurring structure, approach, or convention that works. Keep the why + the shape.",
	},
	gotcha: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A gotcha: a subtle surprise that cost time. Keep the surprising behavior + the fix.",
	},
	metric: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A metric: a measured number worth remembering. Keep the number + when it was measured.",
	},
	false_positive: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A false_positive: something that looked like a lead, rule, or cause but was later disproven. Keep the disproof.",
	},
	experience: {
		operationMode: "upsert",
		requiredFields: ["title", "detail", "experience"],
		stage: "agent",
		tierHint: "experience renders the Situating/Approach/Reflect section at L0 (schema v2)",
		notes: "An experience: a lived debugging/fix session. Prefer it over pattern only when the reflective lineage (what worked, what failed first) is the value; it carries a structured `experience:{situation,approach,reflection}` payload.",
	},
	// ── Ported (D16) ───────────────────────────────────────────────────────
	/** event: add_only — atomic real-world occurrence (OpenViking events.yaml
	 *  contract, measured 2026-08-23). Never merged/deleted toward an existing
	 *  card; each extraction creates its own card keyed by date+slug. */
	event: {
		operationMode: "add_only",
		requiredFields: ["title", "detail", "evidence.first_seen"],
		mergeOps: {
			// add_only: the identity fields never change on a re-ingest.
			id: "immutable",
			created: "immutable",
		},
		stage: "user",
		tierHint: "event renders date+summary at L0 (D17)",
		notes: [
			"An event: one atomic real-world occurrence — a decision, commitment, confirmation,",
			"agreement, proposal, schedule change, ownership assignment, progress update, or result.",
			"NOT the conversation itself — the conversation is the medium, not the event.",
			"Convert relative time to a specific YYYY-MM-DD date. Third person. Keep concrete facts.",
			"Split multi-subject entries into separate atomic events; do not create umbrella",
			"events ('discussed plans', 'team arrangement') when smaller actionable sub-events",
			"exist. Event cards are ADD_ONLY — never merge into or delete an existing event card.",
		].join("\n"),
	},
	case: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A case: a multi-step troubleshooting or solution case — the full story from symptom to resolution (upsert: re-extraction may enrich the same card).",
	},
	preference: {
		operationMode: "upsert",
		requiredFields: ["title", "detail"],
		stage: "user",
		notes: "A preference: a durable user preference (tooling, workflow, style) — an upsert target whose re-extraction refines the recorded preference.",
	},
};

export function isCardType(v: string): v is CardType {
	return v in CARD_TYPES;
}
