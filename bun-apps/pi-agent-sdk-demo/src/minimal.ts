/**
 * Minimal SDK usage.
 *
 * Uses ALL defaults: discovers skills/extensions/context from cwd + ~/.pi/agent,
 * and picks the model from settings.json (your default: zai / glm-5.2).
 *
 * Run: bun run start
 */
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
  session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await session.prompt("What files are in the current directory? Be brief.");
  console.log("\n--- done ---");
} finally {
  session.dispose();
}
