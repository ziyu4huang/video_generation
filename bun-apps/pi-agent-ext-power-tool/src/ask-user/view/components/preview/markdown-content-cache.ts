/**
 * Markdown content cache — memoizes rendered markdown blocks.
 * Ported from rpiv-ask-user-question view/components/preview/markdown-content-cache.ts.
 */
export class MarkdownContentCache {
	private readonly cache = new Map<string, string[]>();

	get(key: string): string[] | undefined {
		return this.cache.get(key);
	}

	set(key: string, lines: string[]): void {
		this.cache.set(key, lines);
	}

	clear(): void {
		this.cache.clear();
	}
}
