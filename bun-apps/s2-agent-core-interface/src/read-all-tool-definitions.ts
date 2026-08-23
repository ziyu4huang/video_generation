/**
 * readAllToolDefinitions — how spawned-child extensions read the parent
 * session's FULL ToolDefinitions (with `execute`), for bridging into child
 * sessions as customTools.
 *
 * Why a two-source read (found by the cc-parity-2 ticket-01 live smoke,
 * 2026-08-23): the ext-api-get-all-tool-definitions patch puts the method on
 * the shared ExtensionRuntime, but since pi-coding-agent 0.84.2
 * `createExtensionAPI` returns a FIXED-SHAPE delegation object (it lists its
 * methods one by one and never spreads the runtime), a method added to the
 * runtime is INVISIBLE on the `pi` object extensions hold. Result: every
 * `pi.getAllToolDefinitions?.()` capture silently returned undefined and
 * spawned children lost ALL parent extension tools (subagent + workflow
 * children saw only read/bash/edit/write; send_message /
 * request_plan_approval never injected). The patch now ALSO publishes the
 * reader on a well-known globalThis key at bindCore time; this helper tries
 * the api first (upstream may expose it natively one day) and falls back to
 * that global.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** The globalThis key the ext-api-get-all-tool-definitions patch publishes on. */
export const ALL_TOOL_DEFINITIONS_GLOBAL = "__s2GetAllToolDefinitions__";

type ToolDefinitionsReader = () => ToolDefinition[];

/**
 * Read the parent session's full tool definitions. Returns undefined when
 * neither source is available (patch disabled, pre-bindCore, or non-pi host) —
 * callers must treat that as "bridge empty", never as "no tools exist".
 */
export function readAllToolDefinitions(pi: unknown): ToolDefinition[] | undefined {
  const viaApi = (pi as { getAllToolDefinitions?: ToolDefinitionsReader }).getAllToolDefinitions?.();
  if (viaApi?.length) return viaApi;
  const viaGlobal = (globalThis as Record<string, unknown>)[ALL_TOOL_DEFINITIONS_GLOBAL];
  if (typeof viaGlobal === "function") {
    const tools = (viaGlobal as ToolDefinitionsReader)();
    if (tools?.length) return tools;
  }
  return undefined;
}
