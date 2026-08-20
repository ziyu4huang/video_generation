/**
 * ext-api-get-all-tool-definitions — monkey-patch ExtensionRunner.prototype.bindCore
 * so ExtensionRuntime (the `pi` object passed to extension factories) exposes
 * `getAllToolDefinitions(): ToolDefinition[]` returning full tool definitions
 * (including `execute`), unlike the existing `getAllTools()` which returns the
 * read-only `ToolInfo[]` (no execute).
 *
 * WHY THIS IS NEEDED
 * ------------------
 * ExtensionAPI.getAllTools() returns ToolInfo[] — a Pick<ToolDefinition, "name" |
 * "description" | "parameters" | "promptGuidelines"> that deliberately OMITS the
 * `execute` function. WorkflowAgent.run() needs full ToolDefinition[] to pass to
 * createAgentSession({ customTools }) so workflow subagents can call the same
 * extension tools the parent session has.
 *
 * ExtensionRunner.getAllRegisteredTools() already returns RegisteredTool[] where
 * RegisteredTool.definition IS the full ToolDefinition — but this method is NOT
 * exposed through ExtensionRuntime/ExtensionAPI (the `pi` object). This patch
 * bridges the gap by adding a `getAllToolDefinitions()` method to the runtime.
 *
 * PATCH LOGIC
 * -----------
 *   bindCore({...actions, contextActions, ...}) {
 *     ...existing assignments...
 *     this.runtime.getAllTools = actions.getAllTools;       // existing: ToolInfo[]
 * +   this.runtime.getAllToolDefinitions = () =>            // added: ToolDefinition[]
 * +     this.getAllRegisteredTools().map(t => t.definition);
 *   }
 *
 * The patch wraps bindCore() via composition: run original, then set the new
 * property. No fragile JS string manipulation.
 *
 * Env gate: BUN_PI_EXT_API_GET_ALL_TOOL_DEFS (default on). Reversible.
 */

import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

// ── Module-scoped flag: apply once ──────────────────────────────────────────
let applied = false;

/**
 * Patch ExtensionRunner.prototype.bindCore to also set
 * runtime.getAllToolDefinitions on the ExtensionRuntime (pi) object.
 *
 * Returns true when the patch was applied, false if it was already applied or
 * the patch target couldn't be found.
 */
export function applyGetAllToolDefinitionsPatch(): boolean {
  if (applied) return false;
  const proto = ExtensionRunner.prototype as unknown as Record<string, unknown>;
  const original = proto.bindCore as ((...args: unknown[]) => void) | undefined;
  if (!original || typeof original !== "function") return false;

  proto.bindCore = function (this: ExtensionRunner, ...args: unknown[]) {
    // Call the original bindCore first — it sets up all existing runtime methods.
    original.apply(this, args);

    // The first argument is actions (ExtensionActions). We don't need it for
    // getAllToolDefinitions because we delegate to getAllRegisteredTools() which
    // is already available on the ExtensionRunner instance.
    const runtime = (this as unknown as { runtime: Record<string, unknown> }).runtime;
    if (!runtime) return;

    // Only set if not already provided (upstream fix landed).
    if (typeof runtime.getAllToolDefinitions === "function") return;

    const self = this as unknown as {
      assertActive: () => void;
      getAllRegisteredTools: () => Array<{ definition: unknown }>;
    };
    runtime.getAllToolDefinitions = () => {
      try {
        self.assertActive();
      } catch {
        return [];
      }
      return self.getAllRegisteredTools().map((t) => t.definition);
    };
  };

  applied = true;
  return true;
}

// Import-time side effect
const debug =
  process.env.BUN_PI_DEBUG_PATCHES === "1" ||
  process.env.BUN_PI_DEBUG_PATCHES === "true";
const enabled = process.env.BUN_PI_EXT_API_GET_ALL_TOOL_DEFS !== "0";
let outcome = false;
if (enabled) {
  const ok = applyGetAllToolDefinitionsPatch();
  outcome = ok;
  if (debug) {
    console.error(
      `[bun-pi] ext-api-get-all-tool-definitions: ${ok ? "applied" : "already applied or failed"}`,
    );
  }
}

/**
 * Whether the wrap actually bound. `applyPatches()` reads this and reports a
 * false as a patch failure instead of claiming success — see ./index.ts.
 * `enabled === false` (env opt-out) is reported as applied: the patch did
 * exactly what it was asked to do.
 */
export const patchApplied = enabled ? outcome : true;
