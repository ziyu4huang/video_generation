// memory-to-vault-discover.ts — scope + noise filter for the memory→vault pipeline.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface MemoryFile {
	/** Absolute path to the .md file. */
	path: string;
	/** Provenance label: "hermes:<basename>" | "project:<dirname>". */
	source: string;
}

export interface DiscoverOptions {
	memoryDir: string;
	projectsDir: string;
	/** Glob restricting which project dirs to include (default: all real ones). */
	only?: string;
}

/** A project-memory dir is NOISE if its name matches any of these. */
const NOISE_PATTERNS = [/^pi-agent-verify-/i, /^tmp/i, /^_backup/i];

function isNoise(dirName: string): boolean {
	return NOISE_PATTERNS.some((re) => re.test(dirName));
}

/** Minimal glob → RegExp supporting only `*` (sufficient for --only video_generation__*). */
function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function discoverMemoryFiles(opts: DiscoverOptions): { files: MemoryFile[]; excluded: number } {
	const files: MemoryFile[] = [];
	let excluded = 0;
	const onlyRe = opts.only ? globToRegExp(opts.only) : null;

	// Global hermes files (fixed set, stable order for deterministic logging).
	const HERMES = ["MEMORY.md", "failures.md", "USER.md"];
	for (const name of HERMES) {
		const abs = join(opts.memoryDir, name);
		if (existsSync(abs) && statSync(abs).size > 0) {
			files.push({ path: abs, source: `hermes:${name}` });
		}
	}

	// Project memory dirs.
	if (existsSync(opts.projectsDir)) {
		for (const dir of readdirSync(opts.projectsDir).sort()) {
			const abs = join(opts.projectsDir, dir);
			if (!statSync(abs).isDirectory()) continue;
			if (isNoise(dir)) { excluded++; continue; }
			if (onlyRe && !onlyRe.test(dir)) { excluded++; continue; }
			const mem = join(abs, "MEMORY.md");
			if (!existsSync(mem) || statSync(mem).size === 0) { excluded++; continue; }
			files.push({ path: mem, source: `project:${dir}` });
		}
	}
	return { files, excluded };
}
