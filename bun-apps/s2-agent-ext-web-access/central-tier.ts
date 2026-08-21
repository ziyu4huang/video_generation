/**
 * central-tier.ts — bridge from web-access LLM defaults to the repo-wide
 * model-tiers config (~/.pi/workflows/model-tiers.json).
 *
 * Every LLM-backed web-access path (query rewrite, auto-summary, Gemini search
 * / URL-context / video analysis, OpenAI web_search) prefers the central
 * `medium` text tier, keeping the historical per-provider candidate lists as
 * fallback for when the tier isn't configured — or, for provider-native API
 * paths, when the tier doesn't point at that provider's family.
 */

import { loadModelTierConfig, resolveModelRole } from "@repo/s2-agent-core-runtime";

/** The text tier web-access defaults to (repo vocabulary: small/medium/big). */
export const DEFAULT_TIER = "medium";

export interface ProviderModelId {
	provider: string;
	id: string;
}

/** Strip a trailing ":thinking" suffix ("provider/id:high" → "provider/id").
 *  Only strips when the colon sits after the provider slash, mirroring
 *  file2md's resolveLLM spec parsing. */
function stripThinking(spec: string): string {
	const colon = spec.lastIndexOf(":");
	const slash = spec.indexOf("/");
	return colon > slash && colon !== -1 ? spec.slice(0, colon) : spec;
}

/** Parse "provider/model-id[:thinking]" → { provider, id }. Returns null when
 *  the spec has no provider/ prefix (bare ids can't drive registry lookups). */
export function parseModelSpec(spec: string): ProviderModelId | null {
	const s = stripThinking(spec);
	const slash = s.indexOf("/");
	if (slash <= 0) return null;
	return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
}

/** Resolve a central text tier to a provider/id pair, or null when unconfigured. */
export function centralTierModel(tier: string = DEFAULT_TIER): ProviderModelId | null {
	const spec = resolveModelRole({ tier }, loadModelTierConfig());
	return spec ? parseModelSpec(spec) : null;
}

/** Central tier model id when its provider is in `families`, else null.
 *  Provider-native API paths (Gemini direct, OpenAI search) can only honor a
 *  central tier that actually points at their provider family — a zai/glm
 *  medium tier must NOT silently become a Gemini API model id. */
export function centralTierModelFor(families: readonly string[], tier: string = DEFAULT_TIER): string | null {
	const model = centralTierModel(tier);
	return model && families.includes(model.provider) ? model.id : null;
}
