/**
 * ext-list.ts — the `--ext-list` diagnostic payload.
 *
 * This is what the deploy's dual-state smoke gate asserts on: once with the
 * extensions present (expects them loaded), once with ext/ moved aside
 * (expects loadedCount 0 and exit 0).
 */
import type { LoadResult } from "./ext-loader.ts";

export function formatExtList(extRoot: string, hostApi: number, r: LoadResult): string {
	return JSON.stringify(
		{
			extRoot,
			hostApi,
			loadedCount: r.loaded.length,
			loaded: r.loaded,
			skillPaths: r.skillPaths,
			skipped: r.skipped,
		},
		null,
		2,
	);
}
