#!/usr/bin/env node
// @ts-nocheck
/**
 * controlled-corpus.mjs — build + index a small, clean vault-mind collection
 * for retrieval-quality measurement.
 *
 * The full s2-agent vault (2907 chunks) is a noisy retrieval field: graph
 * expansion and the semantic seed traverse the WHOLE vault, so a blend-score
 * measurement there conflates "did semantic find the right card" with "did the
 * graph drag in 400 unrelated auto-memory cards". This harness stages a tiny
 * corpus (paper + distill cards, ~24 notes, two distinct domains) and indexes
 * it as its own collection, so semantic / lexical / graph compete on a clean
 * field. The paper↔distill domains share no vocabulary, so cross-domain graph
 * neighbors are visibly spurious if they appear — the graph-dilution signal.
 *
 * Idempotent: removes + re-creates the staging dir, force_reindex:true.
 *
 * USAGE
 *   node scripts/controlled-corpus.mjs                  # stage + index
 *   node scripts/controlled-corpus.mjs --search "query"  # probe semantic
 *   node scripts/controlled-corpus.mjs --status          # collection status
 *
 * Output (stdout, last line): the staging vault path (pass to the retrieval
 * loop as args.vault; --folder is papers-docagent or distill).
 */
import { execSync } from "node:child_process";
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const SRC_VAULT = path.join(PROJECT_ROOT, "vaults_root/s2-agent-vault");
const STAGE_ROOT = path.join(PROJECT_ROOT, "output/controlled-corpus-vault");
// Folders to stage — distinct domains so graph cross-links are visibly spurious.
const FOLDERS = ["Zettelkasten/papers-docagent", "Zettelkasten/distill"];

const VM = process.env.VAULT_MIND_BASE_URL ?? "http://127.0.0.1:8000";

// vault-mind derives collection = "vault_" + sanitize(vault_name); the obsidian
// extension sends vault_name = basename(vault_path) = "controlled-corpus-vault".
// vault-mind normalizes hyphens<->underscores for the /api/search lookup, so
// index with the underscore form (canonical) — search with either works.
const VAULT_NAME = "controlled_corpus_vault";
const COLLECTION = `vault_${VAULT_NAME}`;

function vm(pathname, opts = {}) {
	const url = `${VM}${pathname}`;
	const out = execSync(`curl -s -m ${opts.timeout ?? 20} ${opts.method ? `-X ${opts.method}` : ""} ${opts.body ? `-H "Content-Type: application/json" -d '${JSON.stringify(opts.body).replace(/'/g, "'\\''")}'` : ""} "${url}"`, { encoding: "utf8" });
	return JSON.parse(out);
}

async function stage() {
	if (existsSync(STAGE_ROOT)) await rm(STAGE_ROOT, { recursive: true, force: true });
	await mkdir(path.join(STAGE_ROOT, "Zettelkasten"), { recursive: true });
	let count = 0;
	for (const f of FOLDERS) {
		const src = path.join(SRC_VAULT, f);
		const dst = path.join(STAGE_ROOT, f);
		if (!existsSync(src)) { console.error(`! skip missing ${src}`); continue; }
		await cp(src, dst, { recursive: true });
		const files = await readdir(dst);
		count += files.filter((x) => x.endsWith(".md")).length;
	}
	return count;
}

async function pollJob(jobId, maxSecs = 60) {
	const deadline = Date.now() + maxSecs * 1000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 3000));
		const d = vm(`/api/index/job/${jobId}`, { timeout: 8 }).data ?? {};
		if (d.status === "completed" || d.status === "failed") return d;
	}
	throw new Error(`index job ${jobId} did not complete in ${maxSecs}s`);
}

async function ensureIndexed() {
	// Drop any prior collection of this name (confirmation-token flow).
	const existing = vm(`/api/collections`, { timeout: 8 }).data?.collections ?? [];
	if (existing.some((c) => c.collection_name === COLLECTION)) {
		const tok = vm(`/api/collections/${COLLECTION}`, { method: "DELETE", timeout: 8 }).data?.confirmation_token;
		if (tok) { vm(`/api/collections/${COLLECTION}?confirmation_token=${tok}`, { method: "DELETE", timeout: 15 }); }
		await new Promise((r) => setTimeout(r, 4000));
	}
	const idx = vm(`/api/index`, { method: "POST", timeout: 20, body: {
		vault_name: VAULT_NAME, vault_path: STAGE_ROOT,
		description: "controlled corpus for retrieval-quality measurement",
		force_reindex: true,
	} }).data;
	console.error(`index job ${idx.job_id} (collection=${idx.collection_name})`);
	const done = await pollJob(idx.job_id, 90);
	return done;
}

async function countCards() {
	let n = 0;
	for (const f of FOLDERS) {
		const d = path.join(STAGE_ROOT, f);
		if (existsSync(d)) n += (await readdir(d)).filter((x) => x.endsWith(".md")).length;
	}
	return n;
}

async function main() {
	const arg = process.argv.slice(2)[0] ?? "";
	if (arg === "--status") {
		const d = vm(`/api/collections/${COLLECTION}/status`, { timeout: 8 }).data ?? {};
		console.log(JSON.stringify(d, null, 2));
		return;
	}
	if (arg === "--search") {
		const q = process.argv.slice(3).join(" ");
		const d = vm(`/api/search?vault_name=${VAULT_NAME}&query=${encodeURIComponent(q)}&limit=5&similarity_threshold=0.3`, { timeout: 12 }).data ?? {};
		console.log(JSON.stringify({ query: q, count: d.results?.length ?? 0, top: (d.results ?? []).slice(0, 3).map((r) => ({ score: r.similarity_score?.toFixed(3), title: r.metadata?.file_name })) }, null, 2));
		return;
	}
	const staged = await stage();
	console.error(`staged ${staged} cards at ${STAGE_ROOT}`);
	const done = await ensureIndexed();
	const cards = await countCards();
	const st = vm(`/api/collections/${COLLECTION}/status`, { timeout: 8 }).data ?? {};
	console.error(`indexed: status=${st.status} docs=${st.document_count} (chunks from job: ${done.chunks_created})`);
	console.log(STAGE_ROOT);
}

main().catch((e) => { console.error("controlled-corpus FAILED:", e.message); process.exit(1); });
