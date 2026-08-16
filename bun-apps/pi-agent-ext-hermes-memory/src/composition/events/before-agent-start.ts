/**
 * composition/events/before-agent-start.ts — slice 08b2-3 of the index.ts decomposition.
 *
 * Extracted VERBATIM (behavior preserved) from index.ts L464-473:
 * - registerBeforeAgentStart ← the `pi.on("before_agent_start", ...)` block,
 *   injecting the memory policy (or legacy frozen memory blocks) into the
 *   system prompt.
 *
 * De-closured: every closure variable the body captured from index.ts scope
 * becomes a `ctx` field read on HermesCtx (config, store, projectStore,
 * projectName).
 *
 * The pi before_agent_start event context is unused (`_ctx` → `_evt`, renamed
 * so it cannot shadow the HermesCtx `ctx` param; usage sites unchanged).
 *
 * Helpers called directly: buildPromptContext.
 *
 * index.ts still holds its own copy until the rewire slice — this module
 * must typecheck standalone; it is not imported yet.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HermesCtx } from "../stores.js";
import { buildPromptContext } from "../../prompt-context.js";

/** ← L464-473: the before_agent_start handler, de-closured onto HermesCtx. */
export function registerBeforeAgentStart(pi: ExtensionAPI, ctx: HermesCtx): void {
  pi.on("before_agent_start", async (event, _evt) => {
    const promptContext = await buildPromptContext(ctx.config, ctx.store, ctx.projectStore, ctx.projectName);

    if (promptContext) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + promptContext,
      };
    }
  });
}
