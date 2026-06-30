import type { GalleryImage } from "../types";

/**
 * Quant / format suffixes appended to a transformer name that do NOT make it a
 * different model — e.g. `ernie-redmix-redzit15-8bit` is the same base model as
 * `ernie-redmix-redzit15`, just re-quantized. Stripping these lets an A/B pair
 * (4-bit vs 8-bit of the same base) cluster into ONE group instead of two.
 *
 * Intentionally NARROW: only trailing quant markers. Model-family suffixes that
 * DO change the model (`klein-9b-dark-beast-bfs` = the BFS face-swap variant of
 * klein-9b; `zimage-moody-v126` = a version) are left intact, so they stay in
 * their own groups.
 */
const QUANT_SUFFIX_RE =
  /-((?:4|8|16|32)bit(?:-g\d+)?|bf16|fp16|fp8|f16|f8|requant(?:-test)?)$/;

export function normalizeTransformerKey(
  transformer: string | null | undefined,
): string {
  if (!transformer) return "";
  return transformer.replace(QUANT_SUFFIX_RE, "");
}

// Sentinel key for images with no run.json / transformer (uploads, orphan test
// outputs). Rendered as a trailing catch-all group.
const NO_MODEL_KEY = "__no_model__";

export interface TransformerGroup {
  key: string; // normalized base, or NO_MODEL_KEY
  label: string; // display label
  isNoModel: boolean; // images without a run.json/transformer
  items: GalleryImage[];
}

/**
 * Cluster gallery images by normalized transformer base. Preserves the input's
 * newest-first order both BETWEEN groups (a group sorts by its newest member)
 * and WITHIN a group (members keep their input order). Pure render-time
 * transform — the caller's `images` array is never mutated.
 */
export function groupByTransformer(images: GalleryImage[]): TransformerGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, GalleryImage[]>();

  for (const img of images) {
    const raw = (img.run as Record<string, any> | null)?.transformer;
    const key = raw ? normalizeTransformerKey(raw) : NO_MODEL_KEY;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(img);
  }

  // `order` records each key the first time it's seen = its newest member, so
  // groups are already newest-group-first. Float the "(no model)" bucket to the
  // end — uploads/orphans aren't a model family and read better as a tail group.
  const noModelIdx = order.indexOf(NO_MODEL_KEY);
  if (noModelIdx !== -1) {
    order.splice(noModelIdx, 1);
    order.push(NO_MODEL_KEY);
  }

  return order.map((key) => {
    const isNoModel = key === NO_MODEL_KEY;
    return {
      key,
      label: isNoModel ? "(no model)" : key,
      isNoModel,
      items: buckets.get(key)!,
    };
  });
}
