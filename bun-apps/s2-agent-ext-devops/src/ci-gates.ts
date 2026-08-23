/**
 * readCiGates — the `regression-gates` job from .github/workflows/ci.yml.disabled,
 * as the ordered list of gate commands run_local_ci must run.
 *
 * WHY runLocalCi NEEDS THIS
 *   run_local_ci used to carry a HAND-WRITTEN gate list: two always-on files plus
 *   four under `strict`. The real job has 14 steps. Eight blocking structural
 *   guards were therefore never run by the tool that `merge_pr_after_local_ci` gates the
 *   squash-merge on — dependency-direction, ADR identity/citation, the
 *   status-widget seam contract, bootstrap↔wayfind routing, hermes config-field
 *   parity, the CI-workflow reference guard, package-script runnability, and the
 *   --strict portability audit. A PR breaking any of them merged green. Two
 *   entries pointed the other way: check-workflow-patterns.mjs and
 *   verify-skills.ts are in no workflow step at all.
 *
 *   bun-apps/s2-agent-ext-devops/scripts/ci-local.ts states the rule this module applies: the runner carries
 *   NO copy of the spec, it parses it. src/ci-matrix.ts already does that for
 *   the `tests` matrix; this closes the same hole for the gates.
 *
 * THE DEGRADATION CONTRACT IS INVERTED vs readCiMatrix
 *   An unparseable MATRIX safely degrades to {} — a package with no row still
 *   runs its generic `bun run test`. An unparseable GATE JOB must never degrade
 *   to []: zero gates is indistinguishable from "every gate passed", the exact
 *   false-green this file exists to stop. So every failure surfaces as `error`
 *   and the caller fails the run.
 *
 * EVERY PARSED STEP IS BLOCKING. GitHub fails a job when any step fails, and
 * `regression-gates` carries no `continue-on-error`. The steps whose names say
 * "warn-only" / "not a block" encode that in the SCRIPT (it exits 0 on a warn),
 * not in the job — so there is no blocking/non-blocking distinction to parse
 * out of the names, and parsing one out of prose would be a fresh drift surface.
 */
import { CI_WORKFLOW_PATH } from "./ci-matrix.js";

/** One `run:` step of the regression-gates job. */
export interface CiGate {
	/** The step's `name:` (falls back to the command when unnamed). */
	name: string;
	/** `working-directory:` relative to the repo root; "." when unset. */
	cwd: string;
	/** The `run:` body as a single shell command (newlines collapsed). */
	run: string;
}

export interface CiGatesResult {
	gates: CiGate[];
	/** Set when the job could not be parsed. `gates` is then empty and the caller MUST fail. */
	error?: string;
}

/**
 * Audits that exist in scripts/ but have NO step in the workflow, so nothing
 * else would ever run them. `run_local_ci --strict` adds them on top of the derived
 * set — that is the whole remaining meaning of `strict`: "what CI runs, plus
 * the audits CI has no home for". `tests/ci-gates.test.ts` fails if one of
 * these ever appears in the workflow (it would then run twice).
 */
export const LOCAL_ONLY_AUDITS = ["check-workflow-patterns.mjs", "verify-skills.ts"] as const;

const fail = (message: string): CiGatesResult => ({ gates: [], error: message });

/** Pull the `regression-gates` job's `run:` steps out of a workflow's YAML source. */
export function parseCiGates(yamlSource: string): CiGatesResult {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(yamlSource);
	} catch (e) {
		return fail(`could not parse ${CI_WORKFLOW_PATH} as YAML: ${(e as Error).message}`);
	}
	const job = (doc as { jobs?: Record<string, unknown> } | null)?.jobs?.["regression-gates"] as
		| { steps?: unknown }
		| undefined;
	if (!job) return fail(`no \`regression-gates\` job in ${CI_WORKFLOW_PATH} — the workflow was restructured`);
	const steps = job.steps;
	if (!Array.isArray(steps)) return fail(`\`regression-gates\` has no steps list in ${CI_WORKFLOW_PATH}`);

	const gates: CiGate[] = [];
	for (const raw of steps) {
		const step = raw as { run?: unknown; name?: unknown; "working-directory"?: unknown; if?: unknown };
		// `uses:` steps set up a runner; a dev machine already is one.
		if (typeof step?.run !== "string") continue;
		if (step.if !== undefined) {
			// Guessing a GitHub expression's truth value would silently run or skip
			// the wrong gate set. Refuse rather than subset.
			return fail(
				`gate step ${JSON.stringify(String(step.name ?? "<unnamed>"))} has an \`if:\` this reader cannot evaluate`,
			);
		}
		const run = step.run.trim().split("\n").join(" ");
		gates.push({
			name: typeof step.name === "string" ? step.name : run,
			cwd: typeof step["working-directory"] === "string" ? step["working-directory"] : ".",
			run,
		});
	}
	if (gates.length === 0) return fail(`parsed ZERO gate steps from \`regression-gates\` in ${CI_WORKFLOW_PATH}`);
	return { gates };
}

/** Read + parse the workflow at `<repoRoot>/.github/workflows/ci.yml.disabled`. */
export async function readCiGates(repoRoot: string): Promise<CiGatesResult> {
	let text: string;
	try {
		text = await Bun.file(`${repoRoot}/${CI_WORKFLOW_PATH}`).text();
	} catch (e) {
		return fail(`could not read ${repoRoot}/${CI_WORKFLOW_PATH}: ${(e as Error).message}`);
	}
	return parseCiGates(text);
}
