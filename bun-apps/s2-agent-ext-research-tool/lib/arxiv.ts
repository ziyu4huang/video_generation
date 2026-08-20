/**
 * arXiv discovery + Markdown fetching engine.
 *
 * Ported from @wienerberliner/pi-arxiv (extensions/index.ts) into the
 * research-tool package so arXiv capability rides alongside the existing
 * video-collection / vault tooling. This module is deliberately PURE:
 * only node builtins + fast-xml-parser, no @earendil-works/* imports —
 * matching the lib/bilibili.ts convention so it stays unit-testable and
 * free of SDK coupling. The tool layer (extensions/research-tool.ts) owns
 * truncation, vault writes, and TUI rendering.
 *
 * Design notes vs. the upstream port:
 *  - arxiv_fetch2md writes into the ACTIVE VAULT (<vaultRoot>/papers/),
 *    not a ~/Documents/Arxiv library — so the library-folder discovery,
 *    /arxiv-library command, and session_status hook were dropped.
 *  - 3-second API throttle is preserved (arXiv's polite-use guidance).
 *  - arxiv2md.org HTML→Markdown pipeline is preserved verbatim (it keeps
 *    section structure + math far better than PDF scraping).
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { XMLParser } from "fast-xml-parser";

/* ================================================================
 * Constants
 * ================================================================ */

const ARXIV_API = "https://export.arxiv.org/api/query";
const ARXIV2MD_API = "https://arxiv2md.org/api/markdown";
const USER_AGENT = "@repo/s2-agent-ext-research-tool (arxiv engine; ported from @wienerberliner/pi-arxiv)";
/** arXiv requests a 3s delay between repeated API calls. */
const API_DELAY_MS = 3000;

let lastArxivApiRequestAt = 0;

/* ================================================================
 * Types
 * ================================================================ */

/** A single arXiv paper, parsed from the Atom feed. */
export interface Paper {
	id: string;
	title: string;
	authors: string[];
	abstract: string;
	published: string;
	updated: string;
	categories: string[];
	primaryCategory: string;
	pdfUrl: string;
	absUrl: string;
	comment?: string;
	journalRef?: string;
}

export type ArxivSortBy = "relevance" | "lastUpdatedDate" | "submittedDate";
export type ArxivSortOrder = "ascending" | "descending";

export interface SearchPapersParams {
	query: string;
	category?: string;
	maxResults?: number;
	sortBy?: ArxivSortBy;
	sortOrder?: ArxivSortOrder;
	start?: number;
}

export interface FetchMarkdownParams {
	removeRefs?: boolean;
	removeToc?: boolean;
	removeCitations?: boolean;
	frontmatter?: boolean;
}

/** Tool details shape for arxiv_search. */
export interface SearchDetails {
	query: string;
	category?: string;
	totalResults: number;
	returned: number;
	start: number;
	papers: Paper[];
}

/** Tool details shape for arxiv_paper. */
export interface PaperDetails {
	paper: Paper | null;
}

/** Tool details shape for arxiv_fetch2md. */
export interface FetchMarkdownDetails {
	id: string;
	sourceUrl: string;
	path?: string;
	saved: boolean;
	saveDirectory?: string;
	bytes: number;
	lines: number;
	truncated: boolean;
}

/* ================================================================
 * JSON helpers (the arXiv Atom feed is XML → loosely-typed JSON)
 * ================================================================ */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (isRecord(value)) {
		const text = value["#text"];
		if (typeof text === "string" || typeof text === "number" || typeof text === "boolean") {
			return String(text);
		}
	}
	return "";
}

function attr(record: unknown, name: string): string | undefined {
	if (!isRecord(record)) return undefined;
	const value = record[`@_${name}`];
	return typeof value === "string" ? value : undefined;
}

/* ================================================================
 * arXiv ID parsing
 * ================================================================ */

/**
 * Normalize a raw arXiv identifier or URL into a bare ID.
 * Accepts: 2401.12345, 2401.12345v2, hep-th/9901001,
 *          https://arxiv.org/abs/2401.12345, https://arxiv.org/pdf/2401.12345.pdf
 * Throws on empty / unrecognized input.
 */
export function parseArxivId(raw: string): string {
	const trimmed = raw.trim().replace(/^@/, "");
	if (!trimmed) throw new Error("Empty arXiv ID.");

	let candidate = trimmed;
	try {
		const url = new URL(trimmed);
		const host = url.hostname.toLowerCase();
		const isKnownHost =
			host === "arxiv.org" ||
			host === "www.arxiv.org" ||
			host === "arxiv2md.org" ||
			host === "www.arxiv2md.org" ||
			host === "ar5iv.org" ||
			host === "www.ar5iv.org" ||
			host === "ar5iv.labs.arxiv.org";
		if (isKnownHost) {
			const parts = url.pathname.split("/").filter(Boolean);
			if (parts[0] === "abs" || parts[0] === "pdf" || parts[0] === "html") {
				candidate = parts.slice(1).join("/");
			}
		}
	} catch {
		// Not a URL; treat as a bare arXiv identifier.
	}

	candidate = decodeURIComponent(candidate).replace(/\.pdf$/i, "");

	const modern = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
	const oldStyle = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i;
	if (!modern.test(candidate) && !oldStyle.test(candidate)) {
		throw new Error(
			`Invalid arXiv ID: ${raw}. Expected e.g. 2401.12345, 2401.12345v2, or hep-th/9901001.`,
		);
	}

	return candidate;
}

/* ================================================================
 * Feed parsing
 * ================================================================ */

function parseEntry(entry: unknown): Paper {
	if (!isRecord(entry)) throw new Error("Invalid arXiv API entry.");
	const links = asArray(entry.link).filter(isRecord);
	const pdfLink = links.find((link) => attr(link, "type") === "application/pdf");
	const absLink = links.find((link) => attr(link, "rel") === "alternate");

	const rawId = textValue(entry.id);
	const id = rawId
		.replace(/^https?:\/\/arxiv\.org\/abs\//, "")
		.replace(/^https?:\/\/export\.arxiv\.org\/abs\//, "");

	const authors = asArray(entry.author)
		.map((author) => (isRecord(author) ? textValue(author.name) : ""))
		.filter((author) => author.length > 0);

	const categories = asArray(entry.category)
		.map((category) => attr(category, "term") ?? "")
		.filter((category) => category.length > 0);

	const title = textValue(entry.title).replace(/\s+/g, " ").trim();
	const abstract = textValue(entry.summary).replace(/\s+/g, " ").trim();
	const primaryCategoryValue = entry["arxiv:primary_category"];

	return {
		id,
		title,
		authors,
		abstract,
		published: textValue(entry.published),
		updated: textValue(entry.updated),
		categories,
		primaryCategory: attr(primaryCategoryValue, "term") ?? categories[0] ?? "",
		pdfUrl: attr(pdfLink, "href") ?? `https://arxiv.org/pdf/${id}`,
		absUrl: attr(absLink, "href") ?? `https://arxiv.org/abs/${id}`,
		comment: textValue(entry["arxiv:comment"]) || undefined,
		journalRef: textValue(entry["arxiv:journal_ref"]) || undefined,
	};
}

/** Parse an arXiv Atom feed XML string into papers + totalResult count. */
export function parseFeed(xml: string): { papers: Paper[]; totalResults: number } {
	const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
	const parsed: unknown = parser.parse(xml);
	if (!isRecord(parsed) || !isRecord(parsed.feed)) throw new Error("Invalid arXiv API response.");
	const feed = parsed.feed;
	const totalResults = Number.parseInt(textValue(feed["opensearch:totalResults"]), 10) || 0;
	const papers = asArray(feed.entry).map(parseEntry);
	return { papers, totalResults };
}

function buildSearchQuery(query: string, category?: string): string {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) throw new Error("Search query is required.");
	const base = `all:${trimmedQuery}`;
	return category?.trim() ? `cat:${category.trim()} AND ${base}` : base;
}

/* ================================================================
 * HTTP (rate-limited for the arXiv API)
 * ================================================================ */

async function rateLimitArxivApi(): Promise<void> {
	const now = Date.now();
	const waitMs = Math.max(0, lastArxivApiRequestAt + API_DELAY_MS - now);
	if (waitMs > 0) {
		await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
	}
	lastArxivApiRequestAt = Date.now();
}

async function fetchText(url: URL, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		signal,
		headers: { "user-agent": USER_AGENT },
	});
	if (!response.ok) {
		throw new Error(`Request failed: HTTP ${response.status} ${response.statusText} for ${url.toString()}`);
	}
	return response.text();
}

async function fetchArxivApi(params: URLSearchParams, signal?: AbortSignal): Promise<string> {
	await rateLimitArxivApi();
	const url = new URL(ARXIV_API);
	url.search = params.toString();
	return fetchText(url, signal);
}

/* ================================================================
 * Public API
 * ================================================================ */

/** Search arXiv by query / optional category, with sorting + pagination. */
export async function searchPapers(
	params: SearchPapersParams,
	signal?: AbortSignal,
): Promise<{ papers: Paper[]; totalResults: number; start: number }> {
	const maxResults = Math.max(1, Math.min(Math.floor(params.maxResults ?? 10), 50));
	const start = Math.max(0, Math.floor(params.start ?? 0));
	const query = buildSearchQuery(params.query, params.category);
	const urlParams = new URLSearchParams({
		search_query: query,
		start: String(start),
		max_results: String(maxResults),
		sortBy: params.sortBy ?? "relevance",
		sortOrder: params.sortOrder ?? "descending",
	});
	const xml = await fetchArxivApi(urlParams, signal);
	const { papers, totalResults } = parseFeed(xml);
	return { papers, totalResults, start };
}

/** Exact metadata lookup by arXiv ID or URL. Returns null when not found. */
export async function lookupPaper(rawId: string, signal?: AbortSignal): Promise<Paper | null> {
	const id = parseArxivId(rawId);
	const urlParams = new URLSearchParams({ id_list: id });
	const xml = await fetchArxivApi(urlParams, signal);
	const { papers } = parseFeed(xml);
	const paper = papers[0];
	return paper && paper.title ? paper : null;
}

/** Fetch a paper body as Markdown via the arxiv2md.org HTML→MD pipeline. */
export async function fetchMarkdown(
	id: string,
	params: FetchMarkdownParams,
	signal?: AbortSignal,
): Promise<{ markdown: string; sourceUrl: string }> {
	const url = new URL(ARXIV2MD_API);
	url.searchParams.set("url", id);
	url.searchParams.set("remove_refs", String(params.removeRefs ?? true));
	url.searchParams.set("remove_toc", String(params.removeToc ?? true));
	url.searchParams.set("remove_citations", String(params.removeCitations ?? true));
	url.searchParams.set("frontmatter", String(params.frontmatter ?? true));
	return { markdown: await fetchText(url, signal), sourceUrl: url.toString() };
}

/* ================================================================
 * Formatting + persistence helpers
 * ================================================================ */

/** One-paper human-readable block (used by arxiv_search / arxiv_paper output). */
export function formatPaper(paper: Paper, index?: number): string {
	const prefix = index === undefined ? "" : `[${index + 1}] `;
	const lines = [
		`${prefix}${paper.title}`,
		`    ID: ${paper.id}`,
		`    Authors: ${paper.authors.join(", ") || "Unknown"}`,
		`    Published: ${paper.published.slice(0, 10) || "Unknown"}  Updated: ${paper.updated.slice(0, 10) || "Unknown"}`,
		`    Categories: ${paper.categories.join(", ") || "Unknown"}`,
		`    PDF: ${paper.pdfUrl}`,
		`    Abstract: ${paper.abstract}`,
	];
	if (paper.comment) lines.splice(6, 0, `    Comment: ${paper.comment}`);
	if (paper.journalRef) lines.splice(6, 0, `    Journal: ${paper.journalRef}`);
	return lines.join("\n");
}

/** Compact single-line-ish summary used as the saved-file header. */
export function renderPaperSummary(paper: Paper): string {
	let text = `${paper.title}\n${paper.id} · ${paper.published.slice(0, 10)}`;
	if (paper.authors.length > 0) {
		text += `\n${paper.authors.join(", ")}`;
	}
	return text;
}

/** Sanitize an arXiv ID into a filesystem-safe stem. */
export function safeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9. -]+/g, "_");
}

/** Sanitize a free-form title fragment into a filesystem-safe path part. */
export function safeFilePart(input: string, fallback: string): string {
	const cleaned = input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-zA-Z0-9._ -]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100);
	return cleaned || fallback;
}

/** Return a non-colliding path by appending -2, -3, … when the target exists. */
export async function uniquePath(path: string): Promise<string> {
	if (!existsSync(path)) return path;
	const dotIndex = basename(path).lastIndexOf(".");
	const stem = dotIndex > 0 ? path.slice(0, -basename(path).length + dotIndex) : path;
	const ext = dotIndex > 0 ? basename(path).slice(dotIndex) : "";
	for (let i = 2; i < 1000; i++) {
		const candidate = `${stem}-${i}${ext}`;
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not find an available filename near ${path}`);
}

/**
 * Save a fetched Markdown paper into `directory` as
 * `<safeId(id)> - <safeFilePart(title)>.md` (non-colliding).
 * Returns the absolute path written.
 */
export async function saveMarkdown(
	id: string,
	title: string | undefined,
	markdown: string,
	directory: string,
): Promise<string> {
	await mkdir(directory, { recursive: true });
	const name = `${safeId(id)} - ${safeFilePart(title ?? "", "paper")}.md`;
	const path = await uniquePath(`${directory}/${name}`);
	await writeFile(path, markdown, "utf8");
	return path;
}
