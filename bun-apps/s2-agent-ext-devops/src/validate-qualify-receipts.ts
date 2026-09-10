/**
 * validate-qualify-receipts — the INDEPENDENT grader for qualify sweep
 * receipts (self-arc-21, the deep-exploration report's fix #4).
 *
 * qualify.ts's sweep summaries carry a `pass` field graded by the harness's
 * OWN predicates; until now nothing re-derived those verdicts from primary
 * evidence. This module re-grades every scenario receipt in a sweep dir from
 * that primary evidence ONLY:
 *
 *   - modelLine must name glm-5.3 and never flash (the child-model honesty
 *     rule the sweeps themselves assert — re-derived here, not trusted);
 *   - snap files must exist on disk, COUNT must equal the receipt's own
 *     `snaps` claim, and every REQUIRED label per scenario must be present
 *     (conditional label groups need ≥1 — the SCENARIO_EVIDENCE table below,
 *     frozen from tui-drive.ts's snap emission points + the 2026-09-10 real
 *     sweep `output/qualify19-full/`);
 *   - settle corroboration BY CONTENT (operating learning #5): a terminal
 *     snap whose label marks a settled/terminal state must carry no live
 *     markers (spinner frames, `Working...`) — the filename is a label, not
 *     evidence;
 *   - structural: receipt parses, bytesSeen > 0, timestamps ordered;
 *   - summary.json rows must match the scenario dirs 1:1.
 *
 * INDEPENDENCE (D4): the receipts' self-grades (`pass`, `checks`) are read
 * ONLY to emit `agree` flags in the report — never to derive a verdict. A
 * wrong self-grade is exactly what this grader exists to catch, so the
 * self-grade can never be an input to the grade. Permanent canary:
 * `tests/fixtures/qualify-wrong-self-grade/` — receipts whose self-grade
 * says green while the primary evidence says red MUST be rejected (two-
 * commit red-bar ritual receipted in the arc's evidence/).
 *
 * Pure: sweep dir in → re-graded verdicts out. No spawns, no LLM, no
 * import of qualify.ts or summary.ts (D3/D4 — importing the graded code's
 * own logic would share its blind spots).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Live-marker class copied from the bench harness (screen.ts LIVE_MARKER_RE):
 *  braille spinner frames + `Working...`. A settled screen carries none. */
export const LIVE_MARKER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Working\.\.\./;

export const RECEIPT_FILENAME = "receipt.json";
export const SUMMARY_FILENAME = "summary.json";

/** Per-scenario primary-evidence requirements, frozen from tui-drive.ts's
 *  snap emission points (forced snaps) and confirmed against the real
 *  2026-09-10 sweep. `required` = every label must appear among the snap
 *  files; `anyOf` = each group needs at least ONE label present (conditional
 *  branch alternatives); `settledLike` = which snap labels must show a
 *  settled (live-marker-free) screen. */
export const SCENARIO_EVIDENCE: Record<
	string,
	{ required: string[]; anyOf: string[][]; settledLike: RegExp }
> = {
	dispatch: { required: ["boot", "submitted", "settled", "viewer", "viewer-detail"], anyOf: [], settledLike: /settled/ },
	parallel: { required: ["boot", "submitted", "settled"], anyOf: [], settledLike: /settled/ },
	viewer: {
		required: ["boot", "submitted", "viewer", "follow", "viewer-list", "viewer-closed"],
		anyOf: [],
		settledLike: /viewer-closed/,
	},
	catalog: { required: ["boot"], anyOf: [["routed", "running", "submitted"]], settledLike: /routed/ },
	"cc-parity": {
		required: ["boot"],
		anyOf: [
			["chain-done", "chain-embedded", "chain-1", "chain-sent"],
			["finding", "reviewer-routed", "review-sent"],
		],
		settledLike: /(chain-done|finding)/,
	},
	workflow: {
		required: ["boot", "wf-viewer"],
		anyOf: [["wf-aborted", "wf-aborting"]],
		settledLike: /(wf-aborted|wf-viewer)/,
	},
	"wf-pause": {
		required: ["boot", "pause-navigator", "paused-shared"],
		anyOf: [["completed", "running-again"]],
		settledLike: /(paused-shared|completed)/,
	},
	agents: {
		required: [
			"boot",
			"agents-list",
			"agents-detail",
			"agents-form",
			"agents-created",
			"agents-edit-form",
			"agents-edited",
			"agents-confirm",
			"agents-deleted",
			"agents-closed",
		],
		anyOf: [],
		settledLike: /(agents-deleted|agents-closed)/,
	},
	reload: { required: ["boot", "settled-one", "settled-two"], anyOf: [], settledLike: /settled/ },
	swarm: {
		required: ["boot", "swarm-viewer", "settled"],
		anyOf: [["aborted", "aborting"]],
		settledLike: /settled/,
	},
};

export interface QualifyRegrade {
	scenario: string;
	dir: string;
	derivedPass: boolean;
	problems: string[];
	/** The receipt's self-grade, for the report ONLY (never an input). */
	selfPass: boolean | undefined;
	agree: boolean | undefined;
}

export interface QualifySweepValidation {
	ok: boolean;
	sweepDir: string;
	scenarios: QualifyRegrade[];
	problems: string[];
	/** True when every self-grade agrees with the re-derived verdict. */
	allAgree: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `snap-NN-<label>.txt` → `<label>`; non-snap files are ignored. */
function snapLabel(filename: string): string | undefined {
	const m = /^snap-\d+-(.+)\.txt$/.exec(filename);
	return m ? m[1] : undefined;
}

function regradeScenario(dir: string, scenario: string): QualifyRegrade {
	const problems: string[] = [];
	const evidence = SCENARIO_EVIDENCE[scenario];
	if (!evidence) {
		return {
			scenario,
			dir,
			derivedPass: false,
			problems: [`unknown scenario "${scenario}" — not in the required-evidence table`],
			selfPass: undefined,
			agree: undefined,
		};
	}

	// The receipt itself: structure only.
	const receiptPath = join(dir, RECEIPT_FILENAME);
	if (!existsSync(receiptPath)) {
		return {
			scenario,
			dir,
			derivedPass: false,
			problems: [`missing ${RECEIPT_FILENAME}`],
			selfPass: undefined,
			agree: undefined,
		};
	}
	let receipt: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
		if (!isRecord(parsed)) throw new Error("not an object");
		receipt = parsed;
	} catch (e) {
		return {
			scenario,
			dir,
			derivedPass: false,
			problems: [`receipt.json unparseable: ${(e as Error).message}`],
			selfPass: undefined,
			agree: undefined,
		};
	}
	const selfPass = typeof receipt.pass === "boolean" ? receipt.pass : undefined;

	if (typeof receipt.bytesSeen !== "number" || receipt.bytesSeen <= 0) {
		problems.push(`bytesSeen must be > 0 (got ${String(receipt.bytesSeen)})`);
	}
	const started = typeof receipt.startedAt === "string" ? receipt.startedAt : "";
	const finished = typeof receipt.finishedAt === "string" ? receipt.finishedAt : "";
	if (!started || !finished || !(new Date(started) <= new Date(finished))) {
		problems.push(`timestamps not ordered (startedAt=${started}, finishedAt=${finished})`);
	}

	// Primary evidence: the model line the child actually showed.
	const modelLine = typeof receipt.modelLine === "string" ? receipt.modelLine : "";
	if (!/glm-5\.3/.test(modelLine) || /flash/i.test(modelLine)) {
		problems.push(`modelLine does not prove glm-5.3-not-flash: "${modelLine.trim()}"`);
	}
	const launcher = isRecord(receipt.launcher) ? receipt.launcher : undefined;
	if (!launcher || launcher.tree !== "deployed" || typeof launcher.deployedVersion !== "string" || launcher.deployedVersion.length === 0) {
		problems.push("launcher must record a deployed tree with a version");
	}

	// Primary evidence: the screen snapshots on disk.
	const snapFiles = existsSync(dir) ? readdirSync(dir).filter((f) => snapLabel(f) !== undefined) : [];
	const claimedSnaps = typeof receipt.snaps === "number" ? receipt.snaps : -1;
	if (claimedSnaps !== snapFiles.length) {
		problems.push(`snap count mismatch: receipt claims ${claimedSnaps}, ${snapFiles.length} on disk`);
	}
	const labels = new Set(snapFiles.map((f) => snapLabel(f) as string));
	for (const label of evidence.required) {
		if (!labels.has(label)) problems.push(`required snap label "${label}" absent`);
	}
	for (const group of evidence.anyOf) {
		if (!group.some((label) => labels.has(label))) {
			problems.push(`none of the branch labels [${group.join(", ")}] present`);
		}
	}
	for (const f of snapFiles) {
		const label = snapLabel(f) as string;
		if (evidence.settledLike.test(label) && LIVE_MARKER_RE.test(readFileSync(join(dir, f), "utf8"))) {
			problems.push(`settled snap "${label}" still shows live markers (learning #5: the label is not evidence)`);
		}
	}

	// COMMIT-A (toothless) STATE — the red-bar ritual, self-arc-19 shape:
	// the rules above REPORT but the verdict ECHOES the self-grade. The
	// canary (tests/fixtures/qualify-wrong-self-grade/) runs RED here; the
	// next commit flips the verdict to the evidence derivation (one line)
	// and turns it green. A grader never seen disagreeing with a wrong
	// self-grade has never been seen working.
	return { scenario, dir, derivedPass: selfPass ?? false, problems, selfPass, agree: selfPass === undefined ? undefined : selfPass === (selfPass ?? false) };
}

/** Re-grade a whole sweep dir (one subdir per scenario + summary.json). */
export function validateQualifySweep(sweepDir: string): QualifySweepValidation {
	const problems: string[] = [];
	if (!existsSync(sweepDir)) {
		return { ok: false, sweepDir, scenarios: [], problems: [`sweep dir not found: ${sweepDir}`], allAgree: false };
	}
	const entries = readdirSync(sweepDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	const scenarios = entries.map((name) => regradeScenario(join(sweepDir, name), name));

	// Summary cross-check: rows must match the scenario dirs 1:1.
	const summaryPath = join(sweepDir, SUMMARY_FILENAME);
	let allAgree = scenarios.every((s) => s.agree !== false);
	if (existsSync(summaryPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(summaryPath, "utf8"));
			if (!isRecord(parsed) || !Array.isArray(parsed.rows)) throw new Error("rows array missing");
			const rows = parsed.rows as Array<unknown>;
			const rowScenarios = rows.map((r) => (isRecord(r) && typeof r.scenario === "string" ? r.scenario : ""));
			const dirSet = new Set(entries);
			const rowSet = new Set(rowScenarios);
			for (const s of entries) {
				if (!rowSet.has(s)) problems.push(`summary.json has no row for scenario dir "${s}"`);
			}
			for (const s of rowScenarios) {
				if (!dirSet.has(s)) problems.push(`summary.json row "${s}" has no scenario dir`);
			}
			// D5: rpcCrossCheck is a derived string (or null) — never a raw payload.
			for (const r of rows) {
				if (isRecord(r) && r.rpcCrossCheck != null && typeof r.rpcCrossCheck !== "string") {
					problems.push(`summary row rpcCrossCheck must be a string or null (got ${typeof r.rpcCrossCheck})`);
				}
			}
		} catch (e) {
			problems.push(`summary.json unparseable: ${(e as Error).message}`);
		}
	} else {
		problems.push(`missing ${SUMMARY_FILENAME}`);
	}

	// COMMIT-A (toothless): sweep-level problems are REPORT-ONLY too.
	const ok = scenarios.every((s) => s.derivedPass);
	return { ok, sweepDir, scenarios, problems, allAgree };
}
