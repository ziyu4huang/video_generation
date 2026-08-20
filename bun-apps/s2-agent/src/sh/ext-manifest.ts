/**
 * ext-manifest.ts — pure parse + validation of an extension package's ext.json.
 *
 * Deliberately fs-free and side-effect-free: the loader reads the file, this
 * decides whether the extension is loadable. Validation happens BEFORE any of
 * the extension's code is evaluated, so an incompatible or hostile manifest
 * never gets to run.
 */

/** Shape written by the deploy and read by the loader. */
export interface ExtManifest {
	name: string;
	package: string;
	version: string;
	hostApi: number;
	entry: string;
	order: number;
	enabled: boolean;
	skills: string[];
	/** Data dirs copied beside skills but NOT forwarded as --skill (optional). */
	copy: string[];
	hostModules: string[];
	builtAt?: string;
	sourceSha?: string;
}

export interface HostContract {
	hostApi: number;
	hostModules: readonly string[];
}

export type ParseResult = { ok: true; manifest: ExtManifest } | { ok: false; reason: string };

/** A relative path that stays inside the extension dir: no absolute, no `..` segment. */
function isContainedRelPath(p: unknown): boolean {
	if (typeof p !== "string" || p.length === 0) return false;
	if (p.startsWith("/")) return false;
	return !p.split("/").includes("..");
}

export function parseExtManifest(raw: unknown, dirName: string, host: HostContract): ParseResult {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "ext.json is not a JSON object" };
	}
	const m = raw as Record<string, unknown>;

	for (const field of ["name", "package", "version", "entry"]) {
		if (typeof m[field] !== "string" || (m[field] as string).length === 0) {
			return { ok: false, reason: `ext.json field "${field}" is missing or not a string` };
		}
	}
	if (typeof m.hostApi !== "number" || !Number.isInteger(m.hostApi)) {
		return { ok: false, reason: `ext.json field "hostApi" is missing or not an integer` };
	}
	if (m.name !== dirName) {
		return { ok: false, reason: `ext.json name "${String(m.name)}" does not match directory "${dirName}"` };
	}
	if (m.hostApi !== host.hostApi) {
		return { ok: false, reason: `built for hostApi ${m.hostApi}, host provides ${host.hostApi}` };
	}
	if (!isContainedRelPath(m.entry)) {
		return {
			ok: false,
			reason: `ext.json entry "${String(m.entry)}" must be a relative path inside the extension dir`,
		};
	}

	const skills = m.skills === undefined ? [] : m.skills;
	if (!Array.isArray(skills) || !skills.every((s) => isContainedRelPath(s))) {
		return { ok: false, reason: `ext.json skills must be relative paths inside the extension dir` };
	}

	const copy = m.copy === undefined ? [] : m.copy;
	if (!Array.isArray(copy) || !copy.every((s) => isContainedRelPath(s))) {
		return { ok: false, reason: `ext.json copy must be relative paths inside the extension dir` };
	}

	const hostModules = m.hostModules === undefined ? [] : m.hostModules;
	if (!Array.isArray(hostModules) || !hostModules.every((s) => typeof s === "string")) {
		return { ok: false, reason: `ext.json hostModules must be an array of strings` };
	}
	const missing = (hostModules as string[]).filter((s) => !host.hostModules.includes(s));
	if (missing.length > 0) {
		return { ok: false, reason: `requires host module(s) this host does not provide: ${missing.join(", ")}` };
	}

	const order = m.order === undefined ? 100 : m.order;
	if (typeof order !== "number" || !Number.isFinite(order)) {
		return { ok: false, reason: `ext.json order must be a number` };
	}
	const enabled = m.enabled === undefined ? true : m.enabled;
	if (typeof enabled !== "boolean") {
		return { ok: false, reason: `ext.json enabled must be a boolean` };
	}

	return {
		ok: true,
		manifest: {
			name: m.name as string,
			package: m.package as string,
			version: m.version as string,
			hostApi: m.hostApi,
			entry: m.entry as string,
			order,
			enabled,
			skills: skills as string[],
			copy: copy as string[],
			hostModules: hostModules as string[],
			builtAt: typeof m.builtAt === "string" ? m.builtAt : undefined,
			sourceSha: typeof m.sourceSha === "string" ? m.sourceSha : undefined,
		},
	};
}
