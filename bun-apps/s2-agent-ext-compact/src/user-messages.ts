import type { Message } from "@earendil-works/pi-ai";

export const MAX_USER_MESSAGES = 50;
export const MAX_MESSAGE_CHARS = 2000;

export interface CollectedUserMessage {
  readonly index: number;
  readonly text: string;
  readonly truncated: boolean;
}

function userText(message: Message): string | undefined {
  if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string } | null)?.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || undefined;
}

export function collectUserMessages(
  messages: readonly Message[],
  max: number = MAX_USER_MESSAGES,
  maxChars: number = MAX_MESSAGE_CHARS,
): CollectedUserMessage[] {
  const marker = "…[truncated]";
  const markerLen = marker.length;
  const out: CollectedUserMessage[] = [];
  for (const m of messages) {
    if (out.length >= max) break;
    const text = userText(m);
    if (text === undefined) continue;
    const truncated = text.length > maxChars;
    if (truncated) {
      // Keep total length <= maxChars * 2 (text part + marker)
      const maxTotal = maxChars * 2;
      const sliceLen = Math.max(1, maxTotal - markerLen);
      out.push({
        index: out.length + 1,
        text: `${text.slice(0, sliceLen)}${marker}`,
        truncated,
      });
    } else {
      out.push({
        index: out.length + 1,
        text,
        truncated,
      });
    }
  }
  return out;
}
