import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
	DEFAULT_NEAR_DUP_THRESHOLD,
	MIN_CONTENT_TOKENS,
	containment,
	findNearDuplicate,
	nearDupTokens,
} from "../src/store/near-dup.js";

// Recall-lift fixture: B shares 4 of its 10 filtered tokens with A →
// containment 0.4, inside the [0.3, 0.6) band the old 0.6 threshold missed.
// Every token is a multi-syllable noun (≥4 chars, not a stopword) so
// stopword/length filtering can't wobble the counts.
const SHARED_TOKENS = "orchard lantern meridian cathedral";
const EXISTING_A = `${SHARED_TOKENS} meadow veranda`;
const INCOMING_B = `${SHARED_TOKENS} harbor trellis violin gravel compass marble`;
// Precision fixture: 6 vs 6 distinct unrelated tokens, zero overlap.
const UNRELATED_A = "kayak polka gasket wombat tabby ferret";
const UNRELATED_B = "serene chalet blossom glacier sierra granite";

describe("near-dup threshold (ticket 04 tuning: 0.6 → 0.3)", () => {
	it("locks DEFAULT_NEAR_DUP_THRESHOLD at the tuned 0.3", () => {
		assert.equal(DEFAULT_NEAR_DUP_THRESHOLD, 0.3);
	});

	it("recall-lift: pair in the [0.3, 0.6) band is detected at the default threshold", () => {
		const aTokens = nearDupTokens(EXISTING_A);
		const bTokens = nearDupTokens(INCOMING_B);
		// Fixture sanity BEFORE relying on it: A = 6 tokens, B = 10, 4 shared.
		assert.equal(aTokens.size, 6);
		assert.equal(bTokens.size, 10);
		let shared = 0;
		for (const t of bTokens) if (aTokens.has(t)) shared++;
		assert.equal(shared, 4);

		const sim = containment(bTokens, aTokens);
		assert.ok(sim >= 0.3, `expected sim >= 0.3, got ${sim}`);
		assert.ok(sim < 0.6, `expected sim < 0.6, got ${sim}`);
		assert.ok(sim >= DEFAULT_NEAR_DUP_THRESHOLD);

		const hit = findNearDuplicate(INCOMING_B, [EXISTING_A]);
		assert.ok(hit, "pair in the 0.3–0.6 band must hit at the tuned default");
		assert.equal(hit.index, 0);
		assert.ok(hit.similarity >= 0.3, `expected similarity >= 0.3, got ${hit.similarity}`);
		assert.ok(hit.similarity < 0.6, `expected similarity < 0.6, got ${hit.similarity}`);
		// The OLD 0.6 threshold missed exactly this band — the recall lift this
		// tuning buys.
		assert.equal(findNearDuplicate(INCOMING_B, [EXISTING_A], 0.6), null);
	});

	it("precision: unrelated contents produce no hit", () => {
		const sim = containment(nearDupTokens(UNRELATED_B), nearDupTokens(UNRELATED_A));
		assert.ok(sim < 0.3, `expected sim < 0.3, got ${sim}`);
		assert.equal(findNearDuplicate(UNRELATED_B, [UNRELATED_A]), null);
	});

	it("MIN_TOKENS guard: content with <6 distinctive tokens is always null", () => {
		assert.equal(MIN_CONTENT_TOKENS, 6);
		assert.equal(findNearDuplicate("harbor lantern", ["harbor lantern"]), null);
	});

	it("exact duplicate hits at similarity ~1.0", () => {
		const hit = findNearDuplicate(INCOMING_B, [INCOMING_B]);
		assert.ok(hit, "identical content must hit");
		assert.ok(hit.similarity > 0.99, `expected similarity ~1.0, got ${hit?.similarity}`);
	});
});
