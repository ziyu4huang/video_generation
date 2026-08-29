/**
 * reviewer-harvest — locate a dispatched reviewer subagent's transcript,
 * extract its verdict, write a durable receipt.
 *
 * WHY THIS EXISTS (RCA 2026-08-28, amended 2026-08-29)
 *   The stock claude CLI's child→lead injection was broken for 2.1.247
 *   (never / >24h delayed). The validated workaround — poll the subagent
 *   transcript on disk, take the last assistant text as the verdict, cite
 *   the transcript path in the PR body — was a hand-rolled SOP first used
 *   on PR #2112. CLI 2.1.250 fixed prompt injection (observed ≤45s), so
 *   notifications are PRIMARY again; this tool is the FALLBACK (one
 *   regression away) and, either way, the receipt writer that makes every
 *   independent-review verdict citable after the session ends.
 *
 * TRANSCRIPT LAYOUT (claude-code-glm harness, `~/.claude-glm` root)
 *   <root>/projects/<project-dir>/<session-uuid>/subagents/agent-a<name>-<hash>.jsonl
 *   — one JSON object per line: user (task / tool_result), assistant
 *   (thinking + tool_use + text blocks, `stop_reason: "end_turn"` on the
 *   final turn), and on API death a synthetic assistant line with
 *   `isApiErrorMessage: true` + `model: "<synthetic>"`.
 *
 * CONTRACT (house CLI style, src/cli-common.ts)
 *   stdout: the structured outcome as JSON, nothing else; exit 0 completed
 *   · 1 still-running / absent / errored · 2 usage error. The runnable
 *   entry is scripts/reviewer-harvest.ts (thin wrapper); this file is the
 *   library, so tests drive it with injectable filesystem + clock seams.
 */
import {
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	renameSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";

export type HarvestStatus = "completed" | "still-running" | "absent" | "errored";

/** Filesystem + clock seams — injectable so unit tests never touch the live harness root. */
export interface HarvestIo {
	readdirSync: (p: string) => string[];
	readFileSync: (p: string, enc: "utf8") => string;
	statSync: (p: string) => { mtimeMs: number };
	writeFileSync: (p: string, data: string) => void;
	renameSync: (from: string, to: string) => void;
	existsSync: (p: string) => boolean;
	mkdirSync: (p: string, opts: { recursive: true }) => void;
	sleep: (ms: number) => Promise<void>;
	now: () => Date;
}

export function createLiveIo(): HarvestIo {
	return {
		readdirSync,
		readFileSync: (p, enc) => readFileSync(p, enc),
		statSync,
		writeFileSync,
		renameSync,
		existsSync,
		mkdirSync,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		now: () => new Date(),
	};
}

/** A SendMessage record found in the transcript's tool trail (the notification backup). */
export interface SendMessageBox {
	to: string;
	summary: string;
	message: string;
}

export interface ParsedTranscript {
	status: "completed" | "still-running" | "errored";
	/** Last assistant text on the final end_turn turn — THE verdict. */
	verdict?: string;
	/** The synthetic API-error text when status is errored. */
	error?: string;
	lineCount: number;
	firstTimestamp?: string;
	lastTimestamp?: string;
	sendMessages: SendMessageBox[];
}

function textBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string);
}

/**
 * Pure JSONL → status. Terminal rules, in precedence order:
 *   completed — the LAST assistant line with stop_reason "end_turn" whose
 *     text is non-empty, AND nothing follows it (an end_turn followed by a
 *     resumed turn — a SendMessage nudge to a named agent appends to the
 *     SAME transcript — means the old verdict is stale: reset to
 *     still-running until the resumed turn's own end_turn lands);
 *   errored   — an `isApiErrorMessage` line with no completed verdict after it;
 *   still-running — anything else (task dispatched, verdict not landed yet).
 */
export function parseTranscript(lines: string[]): ParsedTranscript {
	const parsed: ParsedTranscript = { status: "still-running", lineCount: 0, sendMessages: [] };
	for (const line of lines) {
		const raw = line.trim();
		if (!raw) continue;
		parsed.lineCount++;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			continue; // a torn trailing line is exactly what a still-being-written transcript looks like
		}
		if (typeof entry.timestamp === "string") {
			if (!parsed.firstTimestamp) parsed.firstTimestamp = entry.timestamp;
			parsed.lastTimestamp = entry.timestamp;
		}
		const message = entry.message as Record<string, unknown> | undefined;
		if (entry.type !== "assistant" || !message) {
			// a user/tool_result line AFTER a completed verdict = a resumed turn is in flight
			if (entry.type === "user" && parsed.status === "completed") {
				parsed.status = "still-running";
				parsed.verdict = undefined;
			}
			continue;
		}
		const content = message.content;
		// tool trail: capture SendMessage records (child→lead notification backup)
		if (Array.isArray(content)) {
			for (const block of content) {
				if (
					typeof block === "object" &&
					block !== null &&
					(block as { name?: unknown }).name === "SendMessage"
				) {
					const input = (block as { input?: Record<string, unknown> }).input ?? {};
					parsed.sendMessages.push({
						to: String(input.to ?? ""),
						summary: String(input.summary ?? ""),
						message: String(input.message ?? ""),
					});
				}
			}
		}
		const text = textBlocks(content).join("\n").trim();
		if (entry.isApiErrorMessage === true) {
			parsed.status = "errored";
			parsed.error = text || "API error (no text)";
			parsed.verdict = undefined;
			continue;
		}
		if (message.stop_reason === "end_turn" && text) {
			parsed.status = "completed";
			parsed.verdict = text;
			parsed.error = undefined;
			continue;
		}
		// a non-terminal assistant line (thinking / tool_use) after a completed
		// verdict = the resumed turn is working; its end_turn will re-complete
		if (parsed.status === "completed") {
			parsed.status = "still-running";
			parsed.verdict = undefined;
		}
	}
	return parsed;
}

export interface TranscriptCandidate {
	path: string;
	mtimeMs: number;
}

/**
 * Filename shape: `agent-a<name>-<hash>.jsonl`, `<hash>` the trailing
 * hex agent-id suffix (observed 16 hex chars; 8+ tolerated). Because
 * names may contain dashes (`t7-review`), a plain startsWith prefix is
 * NOT an exact match — `--name t7` would steal `t7-review`'s transcript.
 * The captured name must EQUAL the requested name.
 */
const TRANSCRIPT_NAME_RE = /^agent-a(.+)-[0-9a-f]{8,}\.jsonl$/;

export function transcriptNameOf(fileName: string): string | null {
	const m = TRANSCRIPT_NAME_RE.exec(fileName);
	return m ? m[1] : null;
}

/**
 * All transcripts matching the dispatched name under the harness root,
 * newest-first by mtime. The name must match EXACTLY (`t7` must not match
 * `t7-review`; `probe` must not match `probe2`).
 */
export function findTranscripts(opts: {
	harnessRoot: string;
	name: string;
	io: HarvestIo;
}): TranscriptCandidate[] {
	const out: TranscriptCandidate[] = [];
	const projectsDir = join(opts.harnessRoot, "projects");
	let projects: string[];
	try {
		projects = opts.io.readdirSync(projectsDir);
	} catch {
		return [];
	}
	for (const project of projects) {
		const sessionDir = join(projectsDir, project);
		let sessions: string[];
		try {
			sessions = opts.io.readdirSync(sessionDir);
		} catch {
			continue;
		}
		for (const session of sessions) {
			const subagentsDir = join(sessionDir, session, "subagents");
			let files: string[];
			try {
				files = opts.io.readdirSync(subagentsDir);
			} catch {
				continue;
			}
			for (const file of files) {
				if (transcriptNameOf(file) !== opts.name) continue;
				const full = join(subagentsDir, file);
				try {
					out.push({ path: full, mtimeMs: opts.io.statSync(full).mtimeMs });
				} catch {
					continue;
				}
			}
		}
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface HarvestResult {
	status: HarvestStatus;
	name: string;
	harnessRoot: string;
	/** Newest matching transcript (absent when status is "absent"). */
	transcriptPath?: string;
	verdict?: string;
	error?: string;
	lineCount?: number;
	/** Dispatch time = first transcript line's timestamp. */
	dispatchedAt?: string;
	lastActivityAt?: string;
	sendMessages: SendMessageBox[];
	/** Receipt write outcome ("skipped" = nothing to write for absent/still-running). */
	receipt?: { path: string; overwritten: boolean; unchanged: boolean };
	/** Total poll attempts made (1 when no timeout). */
	attempts: number;
}

export interface HarvestOptions {
	name: string;
	harnessRoot?: string;
	/** Total wait budget in ms; 0 (default) = single check, no polling. */
	timeoutMs?: number;
	/** Delay between checks in ms (default 5000). */
	pollMs?: number;
	/** Where receipts land: <repoRoot>/output/reviewer-harvest/. */
	repoRoot: string;
	io?: HarvestIo;
}

/**
 * Poll → parse → receipt. Never throws: every outcome (including absent
 * transcripts and API-dead reviewers) is a JSON-serializable result — a
 * session piping stdout keeps parsing no matter what the reviewer did.
 */
export async function harvest(opts: HarvestOptions): Promise<HarvestResult> {
	const io = opts.io ?? createLiveIo();
	const harnessRoot = opts.harnessRoot ?? join(os.homedir(), ".claude-glm");
	const timeoutMs = opts.timeoutMs ?? 0;
	const pollMs = opts.pollMs ?? 5000;
	const deadline = io.now().getTime() + timeoutMs;
	let attempts = 0;
	for (;;) {
		attempts++;
		const candidates = findTranscripts({ harnessRoot, name: opts.name, io });
		if (candidates.length === 0) {
			if (io.now().getTime() >= deadline) {
				return {
					status: "absent",
					name: opts.name,
					harnessRoot,
					sendMessages: [],
					attempts,
				};
			}
		} else {
			const newest = candidates[0];
			let lines: string[];
			try {
				lines = io.readFileSync(newest.path, "utf8").split("\n");
			} catch {
				lines = [];
			}
			const parsed = parseTranscript(lines);
			if (parsed.status !== "still-running") {
				const result: HarvestResult = {
					status: parsed.status,
					name: opts.name,
					harnessRoot,
					transcriptPath: newest.path,
					verdict: parsed.verdict,
					error: parsed.error,
					lineCount: parsed.lineCount,
					dispatchedAt: parsed.firstTimestamp,
					lastActivityAt: parsed.lastTimestamp,
					sendMessages: parsed.sendMessages,
					receipt: writeReceipt(
						{
							status: parsed.status,
							name: opts.name,
							harnessRoot,
							transcriptPath: newest.path,
							verdict: parsed.verdict,
							error: parsed.error,
							lineCount: parsed.lineCount,
							dispatchedAt: parsed.firstTimestamp,
							lastActivityAt: parsed.lastTimestamp,
							sendMessages: parsed.sendMessages,
						},
						opts.repoRoot,
						io,
					),
					attempts,
				};
				return result;
			}
			if (io.now().getTime() >= deadline) {
				return {
					status: "still-running",
					name: opts.name,
					harnessRoot,
					transcriptPath: newest.path,
					lineCount: parsed.lineCount,
					dispatchedAt: parsed.firstTimestamp,
					lastActivityAt: parsed.lastTimestamp,
					sendMessages: parsed.sendMessages,
					attempts,
				};
			}
		}
		await io.sleep(Math.max(1, Math.min(pollMs, deadline - io.now().getTime())));
	}
}

export interface ReceiptPayload {
	status: HarvestStatus;
	name: string;
	harnessRoot: string;
	transcriptPath?: string;
	verdict?: string;
	error?: string;
	lineCount?: number;
	dispatchedAt?: string;
	lastActivityAt?: string;
	sendMessages: SendMessageBox[];
}

/**
 * FNV-1a over the transcript path → stable receipt filename. Same reviewer
 * transcript re-harvested = same file, so the receipt set cannot grow on
 * repeat polls.
 */
export function receiptFileName(name: string, transcriptPath: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < transcriptPath.length; i++) {
		hash ^= transcriptPath.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${name}-${hash.toString(16).padStart(8, "0")}.json`;
}

/**
 * Write (or confirm) the receipt. Idempotent: re-harvesting the SAME
 * terminal state returns `{ unchanged: true }` and leaves the file
 * byte-identical — the first receipt's harvestedAt timestamp is the
 * durable record of when the verdict landed. The write is atomic
 * (tmp + rename) so a concurrent harvest of the same reviewer can only
 * land a whole receipt, never an interleaved one.
 */
export function writeReceipt(
	payload: ReceiptPayload,
	repoRoot: string,
	io: HarvestIo,
): { path: string; overwritten: boolean; unchanged: boolean } {
	const dir = join(repoRoot, "output", "reviewer-harvest");
	io.mkdirSync(dir, { recursive: true });
	const path = join(dir, receiptFileName(payload.name, payload.transcriptPath ?? "absent"));
	const existed = io.existsSync(path);
	if (existed) {
		try {
			const existing = JSON.parse(io.readFileSync(path, "utf8")) as Record<string, unknown>;
			delete existing.harvestedAt; // the one field allowed to differ (first-write wins)
			const candidate: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
			if (JSON.stringify(existing) === JSON.stringify(candidate)) {
				return { path, overwritten: false, unchanged: true };
			}
		} catch {
			// unreadable/corrupt receipt: fall through and rewrite it
		}
	}
	const tmp = `${path}.tmp`;
	io.writeFileSync(tmp, JSON.stringify({ ...payload, harvestedAt: io.now().toISOString() }, null, 2) + "\n");
	io.renameSync(tmp, path);
	return { path, overwritten: existed, unchanged: false };
}
