/**
 * settings.ts — read/write the `responseLanguage` key in ~/.pi/agent/settings.json.
 *
 * Pure decision functions (getResponseLanguage / withResponseLanguage / isValidTag)
 * are separated from the IO wrappers (readSettingsFile / writeResponseLanguage)
 * so the merge + validation logic is unit-testable without touching the filesystem.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure: read `responseLanguage` from parsed settings. Returns the trimmed tag,
 * or undefined when absent / non-string / blank.
 */
export function getResponseLanguage(
	settings: Record<string, unknown> | undefined,
): string | undefined {
	const v = (settings as { responseLanguage?: unknown } | undefined)?.responseLanguage;
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t || undefined;
}

/**
 * Pure: return a shallow-cloned settings object with `responseLanguage` set to
 * `tag`. Passing `tag === undefined` REMOVES the key (unset). Never mutates input.
 */
export function withResponseLanguage(
	settings: Record<string, unknown> | undefined,
	tag: string | undefined,
): Record<string, unknown> {
	const base: Record<string, unknown> = settings ? { ...settings } : {};
	if (tag === undefined) {
		delete base.responseLanguage;
	} else {
		base.responseLanguage = tag;
	}
	return base;
}

/**
 * Pure: validate a candidate BCP-47-ish tag. Loose — accepts letters, digits,
 * `-`, `_` (1–32 chars). The force-response-language patch maps unknown tags
 * generically, so we only reject clearly-bogus input (whitespace, punctuation,
 * absurd length).
 */
export function isValidTag(tag: string): boolean {
	const t = tag.trim();
	if (!t) return false;
	if (t.length > 32) return false;
	return /^[A-Za-z0-9_-]+$/.test(t);
}

/** IO: best-effort read of ~/.pi/agent/settings.json. Undefined on missing file / parse error. */
export function readSettingsFile(): Record<string, unknown> | undefined {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** IO: merge `tag` into ~/.pi/agent/settings.json (creating the file/dir if needed). */
export function writeResponseLanguage(tag: string): void {
	const current = readSettingsFile() ?? {};
	const next = withResponseLanguage(current, tag);
	const dir = getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(next, null, 2) + "\n");
}
