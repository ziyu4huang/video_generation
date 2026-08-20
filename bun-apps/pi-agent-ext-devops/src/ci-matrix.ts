/**
 * readCiMatrix — the `tests` matrix from .github/workflows/ci.yml.disabled,
 * as a `package → test-cmd` map.
 *
 * WHY runLocalCi NEEDS THIS
 *   `run_local_ci` used to derive each package's command generically (`bun run test`),
 *   which quietly disagrees with what CI would actually run for a third of the
 *   matrix:
 *     - pi-agent-ext-archify / pi-agent-ext-file2md need `bun test --isolate`
 *       (mock.module leaks across files without per-file process isolation);
 *     - pi-agent-ext-tool-gate needs `bun test && bun run qa` (the encoded QA
 *       verdict gate);
 *     - pi-agent-ext-knowledge-card needs its deliberate 3-phase ordering;
 *     - pi-agent-ext-workflow / pi-agent-ext-webui must BUILD first (their `main`
 *       resolves a gitignored dist/).
 *   So `run_local_ci` could report green on a package whose real CI command fails.
 *   The matrix is the specification; this makes it the source of truth for both
 *   runners (scripts/ci-local.sh already parses the same block).
 *
 * NO SECOND COPY OF THE MATRIX. This parses the workflow file; it never carries a
 * hand-maintained table. A package with no row falls back to the generic
 * derivation, and a missing/unparseable workflow degrades to an EMPTY map (the
 * pre-existing generic behavior) rather than throwing — run_local_ci must stay usable
 * in a tree where the workflow moved.
 */

/** `package` → `test-cmd`, exactly as written in the workflow. */
export type CiMatrix = Record<string, string>;

/** Path of the workflow the matrix is parsed out of, relative to the repo root. */
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml.disabled";

/**
 * Pull `jobs.tests.strategy.matrix.include` out of a workflow's YAML source.
 * Returns `{}` for any shape that isn't the expected include list — the caller
 * then falls back to generic per-package derivation.
 */
export function parseCiMatrix(yamlSource: string): CiMatrix {
	let doc: unknown;
	try {
		doc = Bun.YAML.parse(yamlSource);
	} catch {
		return {};
	}
	const include = (doc as { jobs?: { tests?: { strategy?: { matrix?: { include?: unknown } } } } })?.jobs?.tests
		?.strategy?.matrix?.include;
	if (!Array.isArray(include)) return {};
	const out: CiMatrix = {};
	for (const entry of include) {
		const row = entry as { package?: unknown; "test-cmd"?: unknown };
		if (typeof row?.package === "string" && typeof row?.["test-cmd"] === "string") {
			out[row.package] = row["test-cmd"];
		}
	}
	return out;
}

/** Read + parse the workflow at `<repoRoot>/.github/workflows/ci.yml.disabled`. */
export async function readCiMatrix(repoRoot: string): Promise<CiMatrix> {
	try {
		return parseCiMatrix(await Bun.file(`${repoRoot}/${CI_WORKFLOW_PATH}`).text());
	} catch {
		// No workflow file (or unreadable) → generic derivation everywhere.
		return {};
	}
}
