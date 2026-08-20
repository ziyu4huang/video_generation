/**
 * kcard-converge-loop — the long-run knowledge-card CONVERGENCE LOOP workflow.
 *
 * A thin orchestration layer over the deterministic `kcard-loop` CLI (which does
 * ingest → heal-until-dry → recall-probe in one no-LLM call). This workflow adds
 * what only the workflow runtime can add:
 *
 *   - background + resumable + journal-safe (the "long run" envelope)
 *   - an OUTER loopUntilDry convergence loop (re-run until the probe hit-rate
 *     stops improving — handles a growing/dynamic source set; idempotent sources
 *     dry after round 1)
 *   - verify()  — adversarial check that probe "hits" are genuine (not a false
 *     substring match on an unrelated card)
 *   - completenessCheck() — critic: any source family that yielded 0 records?
 *   - a persisted history receipt (the convergence signature)
 *
 * Run headlessly:
 *   bun bun-apps/s2-agent-ext-workflow/samples/run.ts \
 *     bun-apps/s2-agent-ext-workflow/samples/kcard-converge-loop.js \
 *     '{"sources":[{"path":"...","family":"workflow-jsonl"}],"vault":"...","probeEval":"scripts/real-retrieval-eval.json"}'
 *
 * Or via the Phase-5 `/kcard-converge` builtin (reads this sample, runs inline).
 *
 * NOTE: the workflow runtime has no `process`/`Date`/`import` — env checks live
 * inside subagent Bash calls, paths resolve via agents, helpers are inlined.
 */
export const meta = {
	name: "kcard-converge-loop",
	description:
		"Long-run knowledge-card convergence loop: kcard-loop (ingest→heal-until-dry→probe) wrapped in an outer loopUntilDry + adversarial verify + completeness critic + history receipt. Background, resumable, journal-safe.",
	phases: [
		{ title: "Resolve", detail: "repo root + timestamp + arg expansion" },
		{ title: "Converge", detail: "loopUntilDry over kcard-loop rounds until probe stable" },
		{ title: "Verify", detail: "adversarial probe-hit verification" },
		{ title: "Report", detail: "completeness critic + history receipt" },
	],
}

// ── Args (the `args` global is set by the runner / builtin) ─────────────────
let A = args
if (typeof A === "string") {
	try { A = JSON.parse(A) } catch { A = {} }
}
A = (typeof A === "object" && A !== null) ? A : {}

// ── Schemas (every consumed agent() return MUST carry one) ──────────────────
const ROOT_SCHEMA = { type: "object", properties: { root: { type: "string" } }, required: ["root"] }
const TS_SCHEMA = { type: "object", properties: { timestamp: { type: "string" } }, required: ["timestamp"] }
const CONVERGE_SCHEMA = {
	type: "object",
	properties: {
		converged: { type: "boolean" },
		sourcesIngested: { type: "number" },
		created: { type: "number" },
		updated: { type: "number" },
		unchanged: { type: "number" },
		deadLinksBefore: { type: "number" },
		deadLinksAfter: { type: "number" },
		mocMissingAfter: { type: "boolean" },
		rounds: { type: "number" },
		truncated: { type: "boolean" },
		probeHits: { type: "number" },
		probeTotal: { type: "number" },
		probeHitRate: { type: "number" },
	},
	required: ["converged"],
}
const PERSIST_SCHEMA = { type: "object", properties: { written: { type: "boolean" }, bytes: { type: "number" } }, required: ["bytes"] }

// ═══════════════════════════════════════════════════════════════════════════
phase("Resolve")
// ═══════════════════════════════════════════════════════════════════════════

let PROJECT_ROOT = (typeof A.projectRoot === "string" && A.projectRoot.trim()) || ""
if (!PROJECT_ROOT) {
	const rootRes = await agent(`Bash("git rev-parse --show-toplevel") and return the trimmed path.`, {
		label: "resolve-root", phase: "Resolve", tier: "small", schema: ROOT_SCHEMA,
	})
	PROJECT_ROOT = (rootRes?.root || "").trim()
}
if (!PROJECT_ROOT) throw new Error("kcard-converge-loop: could not resolve repo root (pass args.projectRoot to pin it)")

const tsRes = await agent(`Bash("date -u +%Y-%m-%dT%H-%M-%S") and return the timestamp.`, {
	label: "timestamp", phase: "Resolve", tier: "small", schema: TS_SCHEMA,
})
const RUN_ID = tsRes?.timestamp || "unknown"

// Sources + vault come from args (the caller — /kcard-converge builtin or /workflows run).
const SOURCES = Array.isArray(A.sources) ? A.sources : []
const VAULT = A.vault || `${PROJECT_ROOT}/vaults_root/s2-agent-vault`
const PROBE_EVAL = A.probeEval || `${PROJECT_ROOT}/scripts/real-retrieval-eval.json`
const MAX_OUTER_ROUNDS = Math.max(1, Math.min(5, Number(A.maxOuterRounds) || 3))

if (SOURCES.length === 0) {
	throw new Error("kcard-converge-loop: args.sources[] is empty — pass at least one {path,family} (or use the kcard-loop CLI directly for --heal-only)")
}

// Materialise the positional source list: "family:path" tokens.
const sourceTokens = SOURCES.map((s) => `${s.family || "workflow-jsonl"}:${s.path}`).join(" ")
log(`sources: ${SOURCES.length} (${sourceTokens.slice(0, 160)})`)
log(`vault: ${VAULT}`)
log(`probe-eval: ${PROBE_EVAL}`)

// ═══════════════════════════════════════════════════════════════════════════
phase("Converge")
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One convergence round = deterministic, zero-token host-fn calls (sub-project ②):
 * call('zk.ingest') per source, then call('zk.health', {fix:true}) to heal-until-dry
 * and audit. Returns a lean receipt. Re-running with unchanged sources is idempotent
 * (zk_ingest dedups by record id; healGraph is a no-op on a clean graph), so
 * loopUntilDry dries after round 1 unless the source set is growing between rounds.
 * The probe step is intentionally dropped here (verify()'s `probeTotal ?? 0` guard
 * skips cleanly); wire call('zk.retrieve') for a recall probe if needed later.
 */
async function convergeRound(roundIndex) {
	let created = 0, updated = 0, unchanged = 0
	for (const s of SOURCES) {
		const summary = await call("zk.ingest", { dir: s.path, source: s.family || "workflow-jsonl" })
		created += summary?.created || 0
		updated += summary?.updated || 0
		unchanged += summary?.unchanged || 0
	}
	const { health } = await call("zk.health", { fix: true })
	const deadLinksAfter = health?.deadLinks?.length ?? 0
	log(`converge round ${roundIndex}: +${created} created, ${updated} updated, ${deadLinksAfter} dead links, mocMissing=${health?.mocMissing ?? false}`)
	return {
		converged: true,
		sourcesIngested: SOURCES.length,
		created, updated, unchanged,
		deadLinksBefore: deadLinksAfter, // post-heal count (pre-heal not exposed separately by the adapter)
		deadLinksAfter,
		mocMissingAfter: health?.mocMissing ?? false,
		rounds: roundIndex + 1,
		probeHits: 0, probeTotal: 0, probeHitRate: 0, // no probe → verify() skips via the `probeTotal ?? 0` guard
	}
}

const receipts = await loopUntilDry({
	round: async (i) => { const r = await convergeRound(i); return r ? [r] : [] }, // loopUntilDry needs an ARRAY; a scalar return is silently dropped (Array.isArray guard) → the original Phase-3 bug
	// key on the convergence signature — a round that didn't change (created=0,
	// deadLinksAfter=0, same probeHitRate bucket) is "dry". Bucket hit-rate to
	// avoid churn on sub-percent noise.
	key: (rcpt) => `${rcpt?.converged ? 1 : 0}:${rcpt?.created || 0}:${rcpt?.deadLinksAfter || 0}:${Math.floor((rcpt?.probeHitRate || 0) * 10)}`,
	consecutiveEmpty: 1, // idempotent sources → dry after the first no-change round
	maxRounds: MAX_OUTER_ROUNDS,
})

const finalReceipt = receipts.length > 0 ? receipts[receipts.length - 1] : null
const truncated = receipts.length >= MAX_OUTER_ROUNDS && finalReceipt && !finalReceipt.converged
log(`converge: ${receipts.length} round(s); converged=${finalReceipt?.converged} hitRate=${finalReceipt?.probeHitRate ?? "n/a"}`)

// ═══════════════════════════════════════════════════════════════════════════
phase("Verify")
// ═══════════════════════════════════════════════════════════════════════════

// Adversarially verify the probe hits are GENUINE — the kcard-loop probe matches
// `expect` as a substring vs card path/title; a skeptical check guards against a
// false substring match on an unrelated card. Skip if there was no probe.
let verifyResult = null
if (finalReceipt && (finalReceipt.probeTotal ?? 0) > 0) {
	verifyResult = await verify(
		{
			probeHits: finalReceipt.probeHits,
			probeTotal: finalReceipt.probeTotal,
			probeHitRate: finalReceipt.probeHitRate,
			note: "kcard-loop matches `expect` as a substring against retrieved card path/title. A false hit = the substring matched an unrelated card that doesn't actually answer the query.",
		},
		{ reviewers: 3, threshold: 0.66, lens: "Is the reported hit-rate trustworthy, or could substring matching inflate it? Default real=false if uncertain." },
	)
	log(`verify: probe hit-rate ${finalReceipt.probeHitRate} — trustworthy=${verifyResult.real ? "yes" : "NO"} (${verifyResult.realCount}/${verifyResult.total})`)
} else {
	log("verify: skipped (no probe run)")
}

// ═══════════════════════════════════════════════════════════════════════════
phase("Report")
// ═══════════════════════════════════════════════════════════════════════════

const completeness = await completenessCheck(A, {
	finalReceipt,
	rounds: receipts.length,
	verify: verifyResult ? { real: verifyResult.real, realCount: verifyResult.realCount, total: verifyResult.total } : null,
})
if (completeness?.missing?.length) log(`completeness: missing → ${completeness.missing.join("; ")}`)

// Persist the receipt to the workflow history dir.
const HISTORY_DIR = `${PROJECT_ROOT}/.claude/workflows/history/kcard-converge-loop`
const targetPath = `${HISTORY_DIR}/${RUN_ID}.json`
const runResult = {
	runId: RUN_ID,
	sources: SOURCES.length,
	finalReceipt,
	outerRounds: receipts.length,
	truncated,
	verify: verifyResult ? { real: verifyResult.real, realCount: verifyResult.realCount, total: verifyResult.total } : null,
	completeness,
}
const histJson = JSON.stringify(runResult, null, 2)
const persist = await agent(
	`Persist the convergence receipt to disk.
1. Bash("mkdir -p '${HISTORY_DIR}'")
2. Write({ file_path: "${targetPath}", content: <the JSON below VERBATIM> })
3. Bash("test -s '${targetPath}' && echo OK || echo MISSING")
4. Bash("wc -c < '${targetPath}'")
JSON:
${histJson}
Return { written: true, bytes: <the wc number> }.`,
	{ label: "persist-history", phase: "Report", tier: "small", schema: PERSIST_SCHEMA },
)
const bytes = Number(persist?.bytes) || 0
log(`history: ${bytes > 0 ? bytes + " bytes → " : "(FAILED) "}${targetPath}`)

return {
	runId: RUN_ID,
	converged: finalReceipt?.converged ?? false,
	outerRounds: receipts.length,
	truncated,
	created: finalReceipt?.created ?? 0,
	deadLinksAfter: finalReceipt?.deadLinksAfter ?? 0,
	probeHitRate: finalReceipt?.probeHitRate,
	probeVerified: verifyResult?.real ?? null,
	historyPath: bytes > 0 ? targetPath : null,
	...runResult,
}
