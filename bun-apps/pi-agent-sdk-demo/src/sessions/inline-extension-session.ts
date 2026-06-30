/**
 * Session builder: inline extension (no external file).
 *
 * Shared LLM config; adds inline extension factories on top. The factories are
 * baked into the session's resource loader via getSharedServices().
 */
import { Type } from "typebox";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { createSharedSession } from "./shared.ts";

export async function buildInlineExtensionSession() {
  return createSharedSession({
    tools: ["read", "bash", "ping"],
    extensionFactories: [
      (pi: any) => {
        pi.on("agent_start", () => console.log("[ext] ▶ agent_start"));
        pi.on("turn_end", (e: any) => console.log(`[ext] ↳ turn_end #${e.turnIndex}`));
        pi.on("agent_end", (e: any) =>
          console.log(`[ext] ■ agent_end (${e.messages.length} new msgs)`),
        );

        pi.on("tool_call", async (event: any) => {
          if (isToolCallEventType("bash", event)) {
            const cmd = event.input.command ?? "";
            console.log(`[ext] 🔧 bash: ${cmd}`);
            if (cmd.includes("rm -rf")) {
              return { block: true, reason: "rm -rf blocked by inline extension" };
            }
          }
        });

        pi.registerTool({
          name: "ping",
          label: "Ping",
          description: "Returns 'pong' and the current timestamp.",
          promptSnippet: "Check liveness via ping",
          parameters: Type.Object({
            msg: Type.Optional(Type.String({ description: "optional echo text" })),
          }),
          execute: async (_id: string, params: { msg?: string }) => ({
            content: [
              {
                type: "text",
                text: `pong @ ${new Date().toISOString()}${params.msg ? ` — ${params.msg}` : ""}`,
              },
            ],
            details: {},
          }),
        });

        pi.registerCommand("hi", {
          description: "Greet from the inline extension",
          handler: async (_args: unknown, ctx: any) =>
            ctx.ui.notify("Hello from inline extension! 👋", "info"),
        });
      },
    ],
  });
}
