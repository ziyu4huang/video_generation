/**
 * parity-diff — pure dev↔deploy fingerprint comparison.
 *
 * WHY THIS EXISTS
 * ----------------
 * parity-probe captures each side's registration surface; nothing compares
 * them. This module is that comparison, kept PURE so tests need no module
 * mocking, no filesystem, no spawns — fixtures in, findings out.
 *
 * FAIL classes (spec 2026-08-31 §3):
 *   1. deploy-only item (dist ships something dev lacks);
 *   2. shared item with differing hashes (description/schema/skill content —
 *      includes the dirty-source-tree case: the diff speaks, no special rule);
 *   3. dev-only item NOT attributable to a registry-excluded extension
 *      (builtins are always attributable to nobody → must exist on both sides);
 *   4. __PROBE_ERROR__ sentinel on either side (probe itself failed).
 *
 * Attribution (within-side only — paths are NEVER compared across sides):
 * a dev item passes iff some excluded ext matches `/<name>/` OR `/<package>/`
 * in its source path. Fail-loud is the default: an unattributable path is a
 * conscious registry/attribution fix, not a silent pass.
 */
import type { ParityFingerprint } from "./parity-probe.js";

export interface ParityExcludedExt {
	name: string;
	package: string;
	reason: string;
}

export type ParityFindingKind =
	| "deploy-only-tool"
	| "hash-drift-tool"
	| "unattributed-dev-tool"
	| "deploy-only-skill"
	| "hash-drift-skill"
	| "unattributed-dev-skill"
	| "probe-error";

export interface ParityFinding {
	kind: ParityFindingKind;
	item: string;
	detail: string;
}

export interface ParityDiffResult {
	verdict: "pass" | "fail";
	findings: ParityFinding[];
}

const PROBE_ERROR = "__PROBE_ERROR__";

function attributed(path: string, excluded: ParityExcludedExt[]): boolean {
	return excluded.some((e) => path.includes(`/${e.package}/`) || path.includes(`/${e.name}/`));
}

export function diffFingerprints(
	dev: ParityFingerprint,
	deploy: ParityFingerprint,
	excluded: ParityExcludedExt[],
): ParityDiffResult {
	const findings: ParityFinding[] = [];

	for (const t of [...dev.tools, ...deploy.tools]) {
		if (t.n === PROBE_ERROR) {
			findings.push({ kind: "probe-error", item: t.n, detail: `probe read failed on a side: ${t.p}` });
		}
	}

	const devTools = new Map(dev.tools.map((t) => [t.n, t]));
	const depTools = new Map(deploy.tools.map((t) => [t.n, t]));
	for (const [n, dt] of depTools) {
		const vt = devTools.get(n);
		if (!vt) {
			findings.push({ kind: "deploy-only-tool", item: n, detail: `deploy registers "${n}" (${dt.p}); dev does not` });
		} else if (vt.dh !== dt.dh || vt.sh !== dt.sh) {
			findings.push({
				kind: "hash-drift-tool",
				item: n,
				detail: `description/schema hash differs — dev dh=${vt.dh} sh=${vt.sh} vs deploy dh=${dt.dh} sh=${dt.sh}`,
			});
		}
	}
	for (const [n, vt] of devTools) {
		if (!depTools.has(n) && !(vt.s !== "builtin" && attributed(vt.p, excluded))) {
			findings.push({
				kind: "unattributed-dev-tool",
				item: n,
				detail: `dev-only tool "${n}" (source=${vt.s}, path=${vt.p}) not attributable to an excluded extension`,
			});
		}
	}

	const devSkills = new Map(dev.skills.map((s) => [s.n, s]));
	const depSkills = new Map(deploy.skills.map((s) => [s.n, s]));
	for (const [n, ds] of depSkills) {
		const vs = devSkills.get(n);
		if (!vs) {
			findings.push({ kind: "deploy-only-skill", item: n, detail: `deploy ships skill "${n}" (${ds.p}); dev does not` });
		} else if (vs.ch !== ds.ch) {
			findings.push({ kind: "hash-drift-skill", item: n, detail: `skill content hash differs — dev ch=${vs.ch} vs deploy ch=${ds.ch}` });
		}
	}
	for (const [n, vs] of devSkills) {
		if (!depSkills.has(n) && !attributed(vs.p, excluded)) {
			findings.push({
				kind: "unattributed-dev-skill",
				item: n,
				detail: `dev-only skill "${n}" (${vs.p}) not attributable to an excluded extension`,
			});
		}
	}

	return { verdict: findings.length === 0 ? "pass" : "fail", findings };
}
