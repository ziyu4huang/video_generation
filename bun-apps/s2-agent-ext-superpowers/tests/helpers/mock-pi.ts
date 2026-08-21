/**
 * Shared in-memory ExtensionAPI mock (ticket 02 test-dedupe): the mock lived
 * verbatim in bootstrap.test.ts and skill-exclude.test.ts. Drives the
 * extension's event handlers without a real Pi — deterministic, no LLM/network.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx?: any) => any;

export function createMockPi(): ExtensionAPI & {
  handlers: Map<string, Handler>;
  fire: (e: string, ev?: any) => any;
} {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    // Unused by this extension but required by the ExtensionAPI surface shape
    // for callers that probe it; kept permissive.
    sendUserMessage: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const fire = (event: string, ev: any = {}) => handlers.get(event)?.(ev);
  return { ...pi, handlers, fire } as any;
}
