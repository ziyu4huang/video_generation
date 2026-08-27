/**
 * src/resource-tiers.ts — directory L1 overview + L0 abstract generation
 * (effort 2026-08-25-kcard-resource-tier, ticket 02, map D5).
 *
 * Bottom-up, one LLM call per directory: inputs = direct-child file abstracts
 * (deterministic first-sentence, no LLM — D4) + direct-child-dir L0 abstracts
 * (written by the deeper pass that already ran). The L1 overview is written as
 * a `.overview.md` sidecar; the L0 `.abstract.md` is EXTRACTED from L1's brief
 * description (the prose between H1 and the first `##`), clamped — never a
 * second LLM call. Sidecars carry OKF-style frontmatter (`generated_by` +
 * `freshness` counters) and are human-browsable in the vault (map D3).
 *
 * Refresh policy (upstream freshness shape, adapted to batch re-ingest —
 * upstream counts semantic-change events off a queue; we derive the same
 * "pending" count by diffing per-child content hashes against the state kept
 * from the last generation):
 *   - no baseline sidecar → refresh;
 *   - zero changed children → skip (zero LLM calls — idempotent re-ingest);
 *   - total entries ≤ SAMPLE_LIMIT → refresh now;
 *   - else refresh when pending/total ≥ REFRESH_RATIO, otherwise mark pending
 *     (the counter accumulates across ingests until the ratio crosses).
 * Because a parent's inputs are its CHILD ABSTRACTS, a refresh cascades up
 * the ancestor chain only as far as the child text actually changed — sibling
 * directories are never re-called (ticket-02 acceptance).
 *
 * Ported by re-implementation from upstream OpenViking (AGPLv3) ALGORITHMS
 * and prompt SHAPE only — no code copied (spec Further Notes, user directive).
 *
 * Concurrency posture: NO locks — two concurrent resource-ingest runs over the
 * same tree race last-writer-wins on tier-state.json and the sidecars (same
 * posture as ticket 01's embedding cache). Worst case is a redundant refresh,
 * never corruption; do not run concurrent ingests of one tree.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatJson, resolveKgModel } from "./llm-chat.ts";
import { firstSentenceSummary } from "./extractor.ts";

/** Max direct entries fed to one L1 prompt per KIND (upstream
 *  overview_sample_limit=32 — evenly-spanned deterministic sample above it). */
export const TIER_SAMPLE_LIMIT = 32;
/** Refresh when pending/total crosses this (upstream freshness_refresh_ratio). */
export const TIER_REFRESH_RATIO = 0.1;
/** L0 abstract clamp (upstream abstract_max_chars=256). */
export const TIER_ABSTRACT_MAX_CHARS = 256;
/** L1 overview clamp (upstream overview_max_chars=4000). */
export const TIER_OVERVIEW_MAX_CHARS = 4000;

/** Prompt-shape version salt (#2090): baked into the children fingerprint so
 *  a prompt-scheme change (the [N]-index → Markdown-link port) invalidates
 *  existing sidecars exactly once — same discipline as INDEX_SCHEMA_VERSION.
 *  The sidecar's stored fp then differs from the freshly computed one on an
 *  otherwise-unchanged dir, which decide() reads as a forced refresh. */
export const TIER_PROMPT_VERSION = "l1-links-v2";

export const OVERVIEW_SIDEFILE = ".overview.md";
export const ABSTRACT_SIDEFILE = ".abstract.md";

/** L1 generator seam: prompt → markdown overview (null = failure). The default
 *  rides chatJson (llm-chat.ts, `reasoning_effort:"none"` JSON fast path is NOT
 *  used here — the output is markdown, parsed leniently); tests inject a mock. */
export type TierGenerator = (prompt: string, dirUri: string) => Promise<string | null>;

/** Machine state for the freshness diff — kept in the tree's dot-cache dir
 *  (regenerable: losing it degrades to a full refresh, never corruption). */
interface TierStateFile {
	dirs: Record<string, { children: Record<string, string>; pending: number }>;
}

export interface TierDirReceipt {
	uri: string;
	action: "refreshed" | "skipped" | "pending" | "failed";
	/** Prompt size in chars (refreshed dirs only) — the token-budget receipt. */
	promptChars: number;
	totalEntries: number;
	sampledEntries: number;
	pendingChildChanges: number;
}

export interface TierGenerationResult {
	dirs: TierDirReceipt[];
	refreshed: number;
	skipped: number;
	pending: number;
	failed: number;
	llmCalls: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (hermetic test surface)
// ---------------------------------------------------------------------------

/** Stable, order-preserving, evenly-spanned sample (upstream
 *  deterministic_sample): index i·(n−1)/(limit−1) — a monotone map over the
 *  SORTED input, so the same set always yields the same sample. */
export function deterministicSample<T>(items: T[], limit: number): T[] {
	if (limit <= 0) return [];
	if (items.length <= limit) return [...items];
	if (limit === 1) return [items[0]!];
	const out: T[] = [];
	for (let i = 0; i < limit; i++) out.push(items[Math.floor((i * (items.length - 1)) / (limit - 1))]!);
	return out;
}

/** Sentence-boundary clamp (upstream _truncate_generated_text shape): cut at
 *  the last sentence end within the limit; else the first sentence end; else a
 *  word boundary + "…". */
export function truncateAtSentence(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	let firstEnd: number | null = null;
	let lastEnd: number | null = null;
	for (const m of text.matchAll(/\.(?!\d)(?=\s|$)|[!?](?=\s|$)|[。？！]/g)) {
		const end = (m.index ?? 0) + m[0].length;
		if (firstEnd === null) firstEnd = end;
		if (end <= maxChars) lastEnd = end;
		else if (lastEnd !== null) break;
	}
	if (lastEnd !== null) return text.slice(0, lastEnd).trim();
	if (firstEnd !== null) return text.slice(0, firstEnd).trim();
	const candidate = text.slice(0, maxChars - 3).trimEnd();
	const word = candidate.lastIndexOf(" ");
	if (word > 0) return `${candidate.slice(0, word).trimEnd()}...`;
	return `${candidate}...`;
}

/** L0 = the brief-description prose between the H1 and the first `##` of the
 *  L1 overview (upstream _extract_abstract_from_overview shape). */
export function extractAbstractFromOverview(overview: string): string {
	const lines = overview.split("\n");
	const out: string[] = [];
	let inHeader = true;
	for (const line of lines) {
		if (inHeader && line.startsWith("#")) continue; // H1 (and any leading heading block)
		if (inHeader && line.trim()) inHeader = false;
		if (!inHeader) {
			if (line.startsWith("##")) break; // first H2 ends the brief description
			if (line.trim()) out.push(line.trim());
		}
	}
	return out.join("\n").trim();
}

/** Placeholder token scheme (#2090, upstream 8ab07b1e port): each sampled
 *  entry carries a collision-free `kcard-tier://f<N>` (files) /
 *  `kcard-tier://c<N>` (child dirs) placeholder in the prompt; the model
 *  emits Markdown links against them; resolveLinkPlaceholders() swaps them
 *  for tree-relative targets. Replaces the old bare `[N]` index scheme,
 *  whose references survived verbatim into sidecars and resolved to
 *  nothing (measured on the usb4 vault: "see [13]"). */
const TIER_LINK_PLACEHOLDER = /kcard-tier:\/\/([fc])(\d+)/g;

/** Resolve link placeholders against the SAME entry arrays the prompt was
 *  built from (1-based, prompt order — buildOverviewPrompt numbers them).
 *  Files resolve to their filename, child dirs to `name/` (same-directory
 *  relative targets, clickable in Obsidian). Unknown or out-of-range
 *  placeholders are left untouched (upstream discipline: never guess). */
export function resolveLinkPlaceholders(
	text: string,
	files: { name: string }[],
	dirs: { name: string }[],
): string {
	return text.replace(TIER_LINK_PLACEHOLDER, (whole, kind: string, num: string) => {
		const idx = Number(num) - 1;
		const entry = kind === "f" ? files[idx] : dirs[idx];
		if (!entry) return whole; // unknown placeholder — passthrough
		return kind === "f" ? entry.name : `${entry.name}/`;
	});
}

/** L1 prompt — the upstream overview_generation SHAPE re-implemented (title,
 *  scale/coverage statement, link-placeholder file summaries, child-dir
 *  abstracts, faithfulness + sampled-generalization rules, fixed output
 *  structure). */
export function buildOverviewPrompt(args: {
	dirName: string;
	fileSummaries: { name: string; abstract: string }[];
	childDirs: { name: string; abstract: string }[];
	totalFiles: number;
	totalChildren: number;
}): string {
	const provided = args.fileSummaries.length + args.childDirs.length;
	const total = args.totalFiles + args.totalChildren;
	const coverage =
		total <= provided
			? `Total direct entries: ${total}. All direct entries are represented in the summaries below.`
			: `Total direct entries: ${total} (${args.totalFiles} files, ${args.totalChildren} subdirectories).\nSummaries provided for this aggregation: ${provided}.\nDirect entries not individually shown: ${total - provided}.\nCoverage: sampled. The summaries below are representative entries; generalize cautiously and do not treat them as exhaustive.`;
	const files = args.fileSummaries.length
		? args.fileSummaries.map((f, i) => `- ${f.name} (link: kcard-tier://f${i + 1}): ${f.abstract}`).join("\n")
		: "None";
	const dirs = args.childDirs.length
		? args.childDirs.map((d, i) => `- ${d.name}/ (link: kcard-tier://c${i + 1}): ${d.abstract}`).join("\n")
		: "None";
	return `Output Language: English
Write the entire overview in English; do not mix languages.

Generate an overview document based on the following directory content:

[Directory Name]
${args.dirName}

[Directory Scale and Coverage]
${coverage}

[Files and Their Summaries in Directory]
${files}

Each entry above carries a compact link placeholder — kcard-tier://f1, kcard-tier://f2, … for files and kcard-tier://c1, kcard-tier://c2, … for subdirectories. When you reference an entry, write a normal Markdown link using its placeholder as the URL, e.g. [display title](kcard-tier://f1). Use a natural display title (typically the entry's name); do not print the raw placeholder text and do not repeat the name outside the link. Some entries may be structural descriptions rather than prose summaries — treat them as such.

[Subdirectories and Their Summaries]
${dirs}

Faithfulness rules:
- Describe only what the provided summaries state; do not invent entities, facts, or relationships not present in them.
- When the coverage statement says only a sample is shown, you MAY generalize from the sampled entries to characterize the directory as a whole (e.g. "primarily covers X"), using hedging language such as "the sample shows" or "appears to contain"; never claim every entry was examined.
- Never describe specific content of entries not listed above.

Output in Markdown, strictly following this structure:
1. Title (H1): the directory name.
2. Brief Description (a plain-text paragraph, 50-150 words, immediately after the title with NO H2 heading): what this is, what it covers, core keywords from the summaries. Do not include entry counts or sample statistics — keep it useful as a standalone retrieval abstract.
3. Directory Coverage (H2): total direct entries and whether all were represented; when sampled, how many were sampled.
4. Quick Navigation (H2): a decision-tree style guide ("want to learn X → [entry title](kcard-tier://f1)") where every referenced entry is a Markdown link using its placeholder, with concise keyword descriptions.`;
}

/** Default generator: chatJson with an identity-tolerant parse (markdown in,
 *  markdown out — the parseFn only rejects empty text, which triggers
 *  chatJson's single larger-budget retry). `reasoning_effort:"none"` is
 *  REQUIRED even for markdown output: measured 2026-08-25, without it the
 *  local reasoning models leak their chain-of-thought ("Here's a thinking
 *  process: …") into `content`, and the L0 extraction then indexes reasoning
 *  junk as the directory abstract (llm-chat.ts gemma knob note, same class). */
export function defaultTierGenerator(model?: string): TierGenerator {
	return (prompt) =>
		chatJson(prompt, (text) => {
			const t = text.trim();
			return t.length > 0 ? t : null;
		}, {
			model: model ?? resolveKgModel(),
			reasoningEffort: "none",
			maxTokensFirst: 2048,
			timeoutMs: 120_000,
		});
}

// ---------------------------------------------------------------------------
// Frontmatter / sidecar IO
// ---------------------------------------------------------------------------

export interface TierFrontmatter {
	total_entries: number;
	sampled_entries: number;
	unsampled_entries: number;
	pending_child_changes: number;
	children_fingerprint: string;
	generated_model: string;
}

function sha16(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function childrenFingerprint(children: Record<string, string>): string {
	const pairs = Object.entries(children).map(([k, v]) => `${k}:${v}`).sort();
	// Salted with the prompt version (#2090): the fingerprint gates the
	// OUTPUT shape, not just the inputs — see TIER_PROMPT_VERSION.
	return sha16(`${TIER_PROMPT_VERSION}\n${pairs.join("\n")}`);
}

function renderSidecar(fm: TierFrontmatter, body: string): string {
	return [
		"---",
		"generated_by:",
		"  component: kcard-resource-tiers",
		`  model: ${fm.generated_model}`,
		"  trigger: resource-ingest",
		"freshness:",
		`  total_entries: ${fm.total_entries}`,
		`  sampled_entries: ${fm.sampled_entries}`,
		`  unsampled_entries: ${fm.unsampled_entries}`,
		`  pending_child_changes: ${fm.pending_child_changes}`,
		`children_fingerprint: ${fm.children_fingerprint}`,
		"---",
		"",
		body.trimEnd(),
		"",
	].join("\n");
}

/** Parse a sidecar's frontmatter back (tolerant: a missing/invalid block
 *  returns null → the caller treats the dir as baseline-less → refresh). */
export function parseSidecarFrontmatter(raw: string): TierFrontmatter | null {
	const m = raw.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	const block = m[1]!;
	const get = (key: string): string | null => {
		const km = block.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
		return km ? km[1]! : null;
	};
	const total = Number(get("total_entries"));
	const sampled = Number(get("sampled_entries"));
	const fp = get("children_fingerprint");
	const model = block.match(/^\s{2}model:\s*(.+?)\s*$/m)?.[1] ?? "unknown";
	if (!Number.isFinite(total) || !Number.isFinite(sampled) || !fp) return null;
	return {
		total_entries: total,
		sampled_entries: sampled,
		unsampled_entries: Math.max(0, total - sampled),
		pending_child_changes: Number(get("pending_child_changes")) || 0,
		children_fingerprint: fp,
		generated_model: model,
	};
}

/** Sidecar body without the frontmatter block. */
export function sidecarBody(raw: string): string {
	return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

// ---------------------------------------------------------------------------
// Tree model + bottom-up pass
// ---------------------------------------------------------------------------

interface DirNode {
	uri: string; // "" = tree root
	abs: string;
	parent: string | null;
	files: { name: string; abs: string }[]; // direct md children
	childDirs: DirNode[]; // direct
}

/** Collect the directory tree (dot-dirs and tier sidecars excluded from file
 *  lists). Order of the returned array: deepest-first (bottom-up). */
function collectDirTree(rootAbs: string): DirNode[] {
	const byUri = new Map<string, DirNode>();
	const ensure = (uri: string): DirNode => {
		let n = byUri.get(uri);
		if (!n) {
			n = {
				uri,
				abs: uri ? join(rootAbs, uri) : rootAbs,
				parent: uri ? (uri.includes("/") ? uri.slice(0, uri.lastIndexOf("/")) : "") : null,
				files: [],
				childDirs: [],
			};
			if (n.parent !== null) {
				const p = ensure(n.parent);
				p.childDirs.push(n);
			}
			byUri.set(uri, n);
		}
		return n;
	};
	ensure(""); // root always exists even for a flat tree
	const walk = (dirAbs: string, rel: string) => {
		let entries;
		try {
			entries = readdirSync(dirAbs, { withFileTypes: true });
		} catch {
			return; // unreadable subdir — absent from the pass AND the state (degrade, never throw — walkTree precedent, reviewer F1)
		}
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				ensure(childRel);
				walk(join(dirAbs, e.name), childRel);
			} else if (e.isFile() && e.name.endsWith(".md")) {
				ensure(rel).files.push({ name: e.name, abs: join(dirAbs, e.name) });
			}
		}
	};
	walk(rootAbs, "");
	// Sort children by name: readdir order is FS-dependent, and the
	// deterministic sample (and the children fingerprint) must be stable.
	for (const n of byUri.values()) {
		n.files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		n.childDirs.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
	}
	return [...byUri.values()].sort((a, b) => b.uri.length - a.uri.length || (a.uri < b.uri ? -1 : 1));
}

const TIER_STATE_FILE = "tier-state.json";

function tierStatePath(treeRoot: string): string {
	return join(treeRoot, ".resource-semantic", TIER_STATE_FILE);
}

function loadTierState(treeRoot: string): TierStateFile {
	try {
		const parsed = JSON.parse(readFileSync(tierStatePath(treeRoot), "utf8")) as TierStateFile;
		if (parsed && typeof parsed.dirs === "object") return parsed;
	} catch {
		// absent/corrupt — cold (every dir refreshes once, then state rebuilds)
	}
	return { dirs: {} };
}

function saveTierState(treeRoot: string, state: TierStateFile): void {
	try {
		mkdirSync(join(treeRoot, ".resource-semantic"), { recursive: true });
		writeFileSync(tierStatePath(treeRoot), JSON.stringify(state));
	} catch {
		// state write failure is non-fatal — correctness gate lives in the sidecars
	}
}

export interface GenerateTiersArgs {
	treePath: string;
	/** Injectable L1 generator (tests mock; CLI passes defaultTierGenerator()). */
	generator?: TierGenerator;
	/** Plan only: decide per-dir actions, make ZERO LLM calls, write NOTHING. */
	planOnly?: boolean;
	/** Model label stamped into sidecar frontmatter (receipts/audit). */
	llmModel?: string;
}

/** The CANONICAL L0 text a directory contributes to its parent's inputs: the
 *  `.abstract.md` body (exactly what a refresh wrote — clamp included), with a
 *  derive-and-clamp fallback when only the overview exists. Both the refresh
 *  path (hash of the freshly written abstract) and the skip path must agree on
 *  this value or an unchanged dir looks changed (phantom-refresh class, caught
 *  live 2026-08-25: idempotent re-ingest made 2 unneeded LLM calls). */
function readDirAbstract(dirAbs: string, overviewBody: string): string {
	try {
		const body = sidecarBody(readFileSync(join(dirAbs, ABSTRACT_SIDEFILE), "utf8"));
		if (body.length > 0) return body;
	} catch {
		// no abstract sidecar — derive below
	}
	return truncateAtSentence(extractAbstractFromOverview(overviewBody), TIER_ABSTRACT_MAX_CHARS);
}

/**
 * Run the bottom-up L0/L1 pass over the tree under `treePath`. Writes
 * `.overview.md` + `.abstract.md` sidecars for every directory with content,
 * skipping directories whose child inputs are unchanged since their last
 * generation. Returns per-directory receipts (prompt sizes, sample counts,
 * pending counters — the ticket's measurement surface).
 */
export async function generateResourceTiers(args: GenerateTiersArgs): Promise<TierGenerationResult> {
	const root = args.treePath;
	const dirs = collectDirTree(root);
	const state = loadTierState(root);
	const receipts: TierDirReceipt[] = [];
	let llmCalls = 0;
	// Child-dir L0 abstracts collected as the pass ascends (parent prompts read
	// them; a failed child dir contributes just its name — no invented text).
	const l0ByDir = new Map<string, string>();

	for (const dir of dirs) {
		// A directory with no md children and no child dirs holds nothing.
		if (dir.files.length === 0 && dir.childDirs.length === 0) continue;

		// Current per-child input hashes: files hash their CONTENT, child dirs
		// hash their L0 abstract (the only child output a parent consumes).
		const children: Record<string, string> = {};
		for (const f of dir.files) {
			try {
				children[`file:${f.name}`] = sha16(readFileSync(f.abs, "utf8"));
			} catch {
				// unreadable — leave out (degrade, never throw)
			}
		}
		for (const c of dir.childDirs) {
			// ALWAYS keyed (reviewer m5): a child whose generation failed hashes
			// the empty string — the parent sees a stable placeholder, not a
			// phantom REMOVED child that would refresh the ancestor chain on
			// every retry of a flaky-LLM run. Success later flips the hash
			// (the one legit refresh).
			children[`dir:${c.uri.split("/").pop()}`] = sha16(l0ByDir.get(c.uri) ?? "");
		}
		const total = Object.keys(children).length;
		const fingerprint = childrenFingerprint(children);
		const baseline = state.dirs[dir.uri];
		const sidecarPath = join(dir.abs, OVERVIEW_SIDEFILE);
		const abstractPath = join(dir.abs, ABSTRACT_SIDEFILE);
		let existingFm = existsSync(sidecarPath) ? parseSidecarFrontmatter(readFileSync(sidecarPath, "utf8")) : null;

		// Torn-pair heal (reviewer F2): a valid overview whose .abstract.md is
		// missing (deleted, or a disk-full write between the two writes) would
		// otherwise sit on a healthy baseline forever with NO level-0/1 rows —
		// walkSidecars indexes sidecars only as a pair. Regenerate the abstract
		// deterministically from the existing overview — zero LLM calls.
		if (existingFm && !existsSync(abstractPath) && !args.planOnly) {
			try {
				const l0 = readDirAbstract(dir.abs, sidecarBody(readFileSync(sidecarPath, "utf8")));
				writeFileSync(abstractPath, renderSidecar(existingFm, l0), "utf8");
			} catch {
				// heal failed — the refresh path below regenerates both instead
			}
		}

		// Pending = DISTINCT children changed since the last GENERATION (the
		// stored map is the map at generation time, so the diff already
		// accumulates across ingests — adding a carried counter on top
		// double-counted every lingering change per no-op re-ingest, reviewer
		// F3, until a wide dir crossed the ratio on nothing).
		let changed = 0;
		if (baseline) {
			for (const [k, v] of Object.entries(children)) {
				if (baseline.children[k] !== v) changed++;
			}
			for (const k of Object.keys(baseline.children)) {
				if (!(k in children)) changed++;
			}
		}
		const pendingAfter = changed;
		// Baseline health requires BOTH sidecars (F2): a missing abstract after
		// a failed heal must regenerate, not skip.
		const hasBaseline = Boolean(
			baseline && existingFm && existingFm.children_fingerprint && existsSync(abstractPath),
		);

		const dirName = dir.uri ? dir.uri.split("/").pop()! : root.split("/").filter(Boolean).pop() ?? "root";
		const receipt: TierDirReceipt = {
			uri: dir.uri || ".",
			action: "skipped",
			promptChars: 0,
			totalEntries: total,
			sampledEntries: 0,
			pendingChildChanges: pendingAfter,
		};

		const decide = (): "refresh" | "skip" | "pending" => {
			if (!hasBaseline) return "refresh";
			// Prompt-format rollout (#2090): an unchanged dir whose sidecar was
			// generated under an older TIER_PROMPT_VERSION (fingerprint salt
			// differs) regenerates exactly once — the stored fp matches again
			// on the next pass, so idempotency is restored after one sweep.
			if (changed === 0 && existingFm?.children_fingerprint !== fingerprint) return "refresh";
			if (changed === 0) return "skip";
			if (total <= TIER_SAMPLE_LIMIT) return "refresh";
			return pendingAfter / Math.max(total, 1) >= TIER_REFRESH_RATIO ? "refresh" : "pending";
		};
		const action = decide();
		if (action === "skip") {
			// Unchanged inputs: keep the existing sidecar (and its L0 for parents).
			const body = existsSync(sidecarPath) ? sidecarBody(readFileSync(sidecarPath, "utf8")) : "";
			const fm = existingFm!;
			l0ByDir.set(dir.uri, readDirAbstract(dir.abs, body));
			receipt.action = "skipped";
			receipt.sampledEntries = fm.sampled_entries;
			receipts.push(receipt);
			continue;
		}
		if (action === "pending") {
			// Below the refresh ratio: carry the counter, keep the OLD children
			// map (so pending keeps accumulating), do not regenerate.
			state.dirs[dir.uri] = { children: baseline!.children, pending: pendingAfter };
			const body = existsSync(sidecarPath) ? sidecarBody(readFileSync(sidecarPath, "utf8")) : "";
			l0ByDir.set(dir.uri, readDirAbstract(dir.abs, body));
			receipt.action = "pending";
			receipts.push(receipt);
			continue;
		}
		// REFRESH: sample each kind separately (upstream samples file summaries
		// and child abstracts independently), prompt, extract, write.
		const fileEntries = dir.files.map((f) => {
			let content = "";
			try {
				content = readFileSync(f.abs, "utf8");
			} catch {
				// unreadable — empty abstract contribution
			}
			return { name: f.name, abstract: firstSentenceSummary(content) };
		});
		const childDirEntries = dir.childDirs
			.map((c) => ({ name: c.uri.split("/").pop()!, abstract: l0ByDir.get(c.uri) ?? "" }))
			.filter((c) => c.abstract.length > 0);
		const sampledFiles = deterministicSample(fileEntries, TIER_SAMPLE_LIMIT);
		const sampledDirs = deterministicSample(childDirEntries, TIER_SAMPLE_LIMIT);
		const prompt = buildOverviewPrompt({
			dirName,
			fileSummaries: sampledFiles,
			childDirs: sampledDirs,
			totalFiles: fileEntries.length,
			totalChildren: childDirEntries.length,
		});
		receipt.promptChars = prompt.length;
		receipt.sampledEntries = sampledFiles.length + sampledDirs.length;
		// Plan-only stops AFTER the prompt build (dry-run reports prompt sizes —
		// the token-budget measurement surface) but BEFORE any LLM call or
		// write. Populate l0ByDir from any EXISTING sidecar so interior-dir
		// prompts on a partially-generated tree carry real child L0s (reviewer
		// m4 — a fully cold tree still under-reports; the plan is a lower bound).
		if (args.planOnly) {
			if (existsSync(sidecarPath)) {
				l0ByDir.set(dir.uri, readDirAbstract(dir.abs, sidecarBody(readFileSync(sidecarPath, "utf8"))));
			}
			receipt.action = "refreshed";
			receipts.push(receipt);
			continue;
		}

		llmCalls++;
		const generated = args.generator ? await args.generator(prompt, dir.uri) : null;
		if (generated === null || generated.trim().length === 0) {
			receipt.action = "failed";
			receipts.push(receipt);
			continue;
		}
		// Placeholder resolution BEFORE the clamp (#2090): links must land in
		// the sidecar as real tree-relative targets, never as raw tokens.
		const resolved = resolveLinkPlaceholders(generated.trim(), sampledFiles, sampledDirs);
		const overview = truncateAtSentence(resolved, TIER_OVERVIEW_MAX_CHARS);
		const abstract = truncateAtSentence(extractAbstractFromOverview(overview), TIER_ABSTRACT_MAX_CHARS);
		const fm: TierFrontmatter = {
			total_entries: total,
			sampled_entries: receipt.sampledEntries,
			unsampled_entries: Math.max(0, total - receipt.sampledEntries),
			pending_child_changes: 0,
			children_fingerprint: fingerprint,
			generated_model: args.llmModel ?? "unknown",
		};
		try {
			writeFileSync(join(dir.abs, OVERVIEW_SIDEFILE), renderSidecar(fm, overview), "utf8");
			writeFileSync(join(dir.abs, ABSTRACT_SIDEFILE), renderSidecar(fm, abstract), "utf8");
		} catch {
			receipt.action = "failed";
			receipts.push(receipt);
			continue;
		}
		state.dirs[dir.uri] = { children, pending: 0 };
		l0ByDir.set(dir.uri, abstract);
		receipt.action = "refreshed";
		receipts.push(receipt);
	}

	if (!args.planOnly) saveTierState(root, state);
	return {
		dirs: receipts,
		refreshed: receipts.filter((r) => r.action === "refreshed").length,
		skipped: receipts.filter((r) => r.action === "skipped").length,
		pending: receipts.filter((r) => r.action === "pending").length,
		failed: receipts.filter((r) => r.action === "failed").length,
		llmCalls,
	};
}
