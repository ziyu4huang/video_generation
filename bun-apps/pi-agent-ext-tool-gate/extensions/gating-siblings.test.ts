/**
 * gating-siblings — the sibling-group drift guard.
 *
 * tool-gate groups co-firing tools into FAMILIES by fingerprint equality over
 * their owner-declared gating (gatesWithSameGating → gateGatingKey). Family
 * membership is maintained by copy-paste: the same keyword literal is repeated
 * once per member, sometimes across package boundaries (workflow/workflow_help/
 * workflow_control live in pi-agent-ext-workflow; subagent/subagents live in
 * pi-agent-ext-subagent — five members, one literal). Editing ONE member ejects
 * it from its family with no type error, no test failure, and no runtime
 * warning; the only symptom is a tool that stops appearing when the user
 * expects it.
 *
 * The guard: group every non-core gate by fingerprint, then assert that no two
 * DISTINCT groups share more than half of the smaller group's keywords.
 *
 *   cover(A,B) = |A ∩ B| / min(|A|, |B|)   must be <= 0.5
 *
 * Calibration (measured 2026-08-10 over 29 non-core gated tools in 10 groups):
 * the overlap distribution is strictly BIMODAL — every overlapping pair is
 * fingerprint-identical (cover 1.000) and every cross-group pair shares ZERO
 * keywords. So the guard is green at 0 violations today with wide margin.
 *
 * Why 0.5 and not "any overlap fails": an editing accident leaves the two sides
 * near-identical (drop one of movie's 16 keywords → 15 shared → cover 0.94),
 * which 0.5 catches easily, while leaving room for two genuinely unrelated
 * gates to share a word or two in future without needing an exemption. The
 * comparison is strictly ABOVE the threshold (`> 0.5`, not `>=`): at 2 keywords
 * two unrelated gates sharing one generic word ("video") lands on exactly 0.500,
 * and this guard has no exemption mechanism, so that boundary case must not
 * fail. Real drift lands at 0.57–1.00, nowhere near it.
 *
 * Core gates (gating:{core:true}) are excluded: they carry no keywords and are
 * always active, so they have no family to drift out of.
 *
 * Coverage limit: `cover` is 0 when EITHER keyword set is empty, so a family
 * gated purely by `requires` (empty `keywords`) can never be flagged however far
 * its `requires` drift. Such gates are legal here (drift-guard accepts
 * `hasKeywords || canFireRequires`); there are 0 today, so this is latent.
 */
import { describe, expect, test } from "bun:test";
import { MIGRATED_EXTENSIONS, captureRegisteredTools, type ToolDef } from "./migrated-extensions.ts";
import { gateGatingKey } from "./tool-gate.ts";

// NOTE: nothing below is exported, deliberately. Importing from a `.test.ts`
// is broken in both directions — from a plain script it hard-errors ("Cannot
// use describe outside of the test runner"), and from another `.test.ts` under
// `bun test` this file's suites RE-EXECUTE inside the importer. If a second
// consumer ever needs these pure helpers, extract them into a non-test sibling
// (`extensions/gating-siblings.ts`) and import from there — that is exactly why
// migrated-extensions.ts is a non-test module (see its header).

/** One captured non-core gate, reduced to what the guard compares. */
interface GateRow {
	tool: string;
	ext: string;
	keywords: string[];
	fingerprint: string;
}

/**
 * Fingerprint a tool def's gating using tool-gate's OWN gateGatingKey, by
 * adapting the def into the minimal ToolGate shape that function reads
 * (`names` and `description` are ignored by it).
 *
 * Normalizing `requires` is deliberate, not incidental: ToolGate's CoOccurrence
 * declares `nouns`/`verbs` as REQUIRED string[], while a captured def types them
 * as optional unknown[]. Passing `undefined` through when the def has no
 * `requires` matches gateGatingKey's own `requires ? … : null` branch, so a
 * gate with no co-occurrence fingerprints the same here as it does at runtime.
 */
function fingerprintOf(def: ToolDef): string {
	const g = def.gating ?? {};
	const req = g.requires;
	return gateGatingKey({
		names: [def.name ?? "<anonymous>"],
		description: "",
		keywords: g.keywords ?? [],
		requires: req
			? { nouns: (req.nouns ?? []) as string[], verbs: (req.verbs ?? []) as string[] }
			: undefined,
	});
}

/** Every non-core gated tool registered by every migrated extension. */
function collectGateRows(extensions: typeof MIGRATED_EXTENSIONS): GateRow[] {
	const rows: GateRow[] = [];
	for (const ext of extensions) {
		for (const def of captureRegisteredTools(ext.register)) {
			const g = def.gating;
			if (!g || g.core === true) continue;
			rows.push({
				tool: def.name ?? "<anonymous>",
				ext: ext.name,
				keywords: [...(g.keywords ?? [])],
				fingerprint: fingerprintOf(def),
			});
		}
	}
	return rows;
}

/** Shared keywords / size of the smaller keyword set. 0 when either side is empty. */
function cover(a: string[], b: string[]): number {
	const A = new Set(a);
	const B = new Set(b);
	const smaller = Math.min(A.size, B.size);
	if (smaller === 0) return 0;
	let shared = 0;
	for (const k of A) if (B.has(k)) shared++;
	return shared / smaller;
}

interface SiblingViolation {
	a: GateRow;
	b: GateRow;
	cover: number;
}

/**
 * Every pair of rows from DIFFERENT fingerprint groups whose keyword cover
 * EXCEEDS `threshold` — i.e. two tools that look like siblings but will not
 * co-fire. Strictly `>` so an exactly-half overlap (2 keywords, 1 shared) is
 * not a false failure; see the header. Pure.
 */
function findSiblingDrift(rows: GateRow[], threshold = 0.5): SiblingViolation[] {
	const out: SiblingViolation[] = [];
	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			const a = rows[i]!;
			const b = rows[j]!;
			if (a.fingerprint === b.fingerprint) continue; // same family — fine
			const c = cover(a.keywords, b.keywords);
			if (c > threshold) out.push({ a, b, cover: c });
		}
	}
	return out;
}

describe("gating-siblings — the guard itself is not vacuous", () => {
	test("flags two near-identical gates that are NOT fingerprint-equal", () => {
		// The exact Spec B failure mode: movie's 16 keywords, minus one on the
		// help side. 15 shared / min(16,15) = 1.0 → far above threshold.
		const kws = [
			"montage", "preflight", "storyboard", "分鏡", "剪輯",
			"影片製作", "導演", "make a movie", "make a film", "movie director",
			"compose video", "compose scene", "電影製作",
			"short film", "into a film", "scenes into",
		];
		const rows: GateRow[] = [
			{ tool: "movie", ext: "x", keywords: kws, fingerprint: "FP-A" },
			{ tool: "movie_help", ext: "x", keywords: kws.slice(0, 15), fingerprint: "FP-B" },
		];
		const found = findSiblingDrift(rows);
		expect(found.length).toBe(1);
		expect(found[0]!.cover).toBeGreaterThanOrEqual(0.5);
	});

	test("does NOT flag a real sibling pair (same fingerprint, full overlap)", () => {
		const kws = ["workflow", "pipeline", "orchestrate"];
		const rows: GateRow[] = [
			{ tool: "workflow", ext: "w", keywords: kws, fingerprint: "FP-SAME" },
			{ tool: "workflow_help", ext: "w", keywords: kws, fingerprint: "FP-SAME" },
		];
		expect(findSiblingDrift(rows)).toEqual([]);
	});

	test("does NOT flag unrelated gates sharing one incidental keyword", () => {
		const rows: GateRow[] = [
			{ tool: "alpha", ext: "a", keywords: ["video", "a2", "a3", "a4"], fingerprint: "FP-1" },
			{ tool: "beta", ext: "b", keywords: ["video", "b2", "b3", "b4"], fingerprint: "FP-2" },
		];
		// cover = 1/4 = 0.25 < 0.5
		expect(findSiblingDrift(rows)).toEqual([]);
	});
});

describe("gating-siblings — the live repo has no sibling drift", () => {
	test("no two distinct fingerprint groups share MORE THAN half of the smaller group's keywords", () => {
		const rows = collectGateRows(MIGRATED_EXTENSIONS);
		// Non-vacuous: the capture must actually have found the known families.
		expect(rows.length, "capture must be non-empty (else the guard passes vacuously)").toBeGreaterThan(0);
		const names = new Set(rows.map((r) => r.tool));
		for (const n of ["movie", "movie_help", "workflow", "subagent"]) {
			expect(names.has(n), `expected '${n}' in the captured non-core gate set`).toBe(true);
		}

		const violations = findSiblingDrift(rows);
		const only = (from: string[], other: string[]): string => {
			const set = new Set(other);
			return JSON.stringify(from.filter((k) => !set.has(k)));
		};
		const detail = violations
			.map(
				(v) =>
					`  ${v.a.tool} (${v.a.ext}) vs ${v.b.tool} (${v.b.ext}) — cover ${v.cover.toFixed(2)}; ` +
					`only in ${v.a.tool}: ${only(v.a.keywords, v.b.keywords)}; ` +
					`only in ${v.b.tool}: ${only(v.b.keywords, v.a.keywords)}; ` +
					`these look like siblings but have DIFFERENT gating fingerprints, so they will NOT co-fire. ` +
					`Either make their gating identical (share ONE object) or make them genuinely distinct.`,
			)
			.join("\n");
		expect(violations.length, violations.length ? `sibling-group drift detected:\n${detail}` : "").toBe(0);
	});

	test("movie and movie_help are in the SAME fingerprint group", () => {
		const rows = collectGateRows(MIGRATED_EXTENSIONS);
		const movie = rows.find((r) => r.tool === "movie");
		const help = rows.find((r) => r.tool === "movie_help");
		expect(movie).toBeDefined();
		expect(help).toBeDefined();
		expect(movie!.fingerprint).toBe(help!.fingerprint);
	});
});
