export type ExtractStrategy = "vlm" | "text" | "hybrid";
export const DEFAULT_EXTRACT: ExtractStrategy = "vlm";
const VALID = new Set<ExtractStrategy>(["vlm", "text", "hybrid"]);
export function parseExtractStrategy(s: string | undefined): ExtractStrategy {
  if (s === undefined) return DEFAULT_EXTRACT;
  if (VALID.has(s as ExtractStrategy)) return s as ExtractStrategy;
  throw new Error(`Invalid extract "${s}". Valid: vlm, text, hybrid.`);
}
