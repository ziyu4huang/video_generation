#!/usr/bin/env bun
/**
 * fetch-fixtures.ts — download-on-demand for the 3 fixture PDFs that exceed
 * the repo's 2 MB file-size guard (large-sources.json pins their arXiv URL
 * + sha256). Bytes are verified before use; cached under output/bench-cache/
 * (gitignored). Offline runs skip loudly.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const CACHE = join(ROOT, "output", "bench-cache");
const MANIFEST = join(import.meta.dir, "..", "fixtures", "large-sources.json");

export async function ensureLargeFixture(arxivId: string): Promise<string | null> {
	const manifest = JSON.parse(await Bun.file(MANIFEST).text()) as {
		items: { arxivId: string; url: string; sha256: string }[];
	};
	const item = manifest.items.find((i) => i.arxivId === arxivId);
	if (!item) return null;
	mkdirSync(CACHE, { recursive: true });
	const dest = join(CACHE, `${arxivId}.pdf`);
	if (existsSync(dest)) {
		const h = new Bun.CryptoHasher("sha256");
		h.update(await Bun.file(dest).arrayBuffer());
		if (h.digest("hex") === item.sha256) return dest;
	}
	try {
		const res = await fetch(item.url);
		if (!res.ok) return null;
		const buf = new Uint8Array(await res.arrayBuffer());
		const h = new Bun.CryptoHasher("sha256");
		h.update(buf);
		if (h.digest("hex") !== item.sha256) {
			console.error(`[fetch-fixtures] ${arxivId}: sha256 mismatch — refusing`);
			return null;
		}
		await Bun.write(dest, buf);
		return dest;
	} catch (e) {
		console.error(`[fetch-fixtures] ${arxivId}: download failed (${(e as Error).message})`);
		return null;
	}
}
