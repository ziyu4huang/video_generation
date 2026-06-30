/**
 * Session builder: custom tools.
 *
 * Shared LLM config; adds one custom tool (get_uptime) on top.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createSharedSession } from "./shared.ts";

const getUptime = defineTool({
  name: "get_uptime",
  label: "Get Uptime",
  description: "Returns the current process uptime in seconds.",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: `Uptime: ${process.uptime().toFixed(2)}s` }],
    details: {},
  }),
});

export async function buildCustomToolsSession() {
  return createSharedSession({
    tools: ["read", "bash", "get_uptime"],
    customTools: [getUptime],
  });
}
