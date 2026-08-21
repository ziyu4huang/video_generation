import type { Model, Api } from "@earendil-works/pi-ai";

export type ModelApi = Model<Api>;

export interface ModelLookup {
  find(provider: string, id: string): ModelApi | undefined;
}

export interface ModelContext {
  model: ModelApi | undefined;
  modelRegistry: ModelLookup;
}

/** Strip a trailing ":thinking" suffix ("provider/id:high" → "provider/id"). */
function stripThinking(spec: string): string {
  const colon = spec.lastIndexOf(":");
  const slash = spec.indexOf("/");
  return colon > slash && colon !== -1 ? spec.slice(0, colon) : spec;
}

/** Parse "provider/model-id[:thinking]" → { provider, id }; null when no provider slash. */
export function parseModelSpec(spec: string): { provider: string; id: string } | null {
  const s = stripThinking(spec);
  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  return { provider: s.slice(0, slash), id: s.slice(slash + 1) };
}

/** Override spec → registry lookup; unresolvable override falls back to the session model. */
export function pickModel(ctx: ModelContext, overrideSpec: string | undefined): ModelApi | undefined {
  if (overrideSpec) {
    const parsed = parseModelSpec(overrideSpec);
    if (parsed) {
      const matched = ctx.modelRegistry.find(parsed.provider, parsed.id);
      if (matched) return matched;
    }
  }
  return ctx.model;
}
