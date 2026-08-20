import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FakePi {
  pi: ExtensionAPI;
  emitted: { channel: string; data: unknown }[];
  appendEntries: { type: string; payload: unknown }[];
  trigger(event: string, ...args: unknown[]): void;
}

type AnyHandler = (...args: unknown[]) => unknown;

/**
 * Recording fake ExtensionAPI for webui-seam tests: an in-memory EventBus
 * (emit fans out to on-handlers and records every emission) plus a recording
 * appendEntry and on-handler registry. Extend the stub object with any extra
 * no-op methods the code under test touches — mirror the mock style of
 * __tests__/registration.test.ts (makeRecorderPi) / extension-contract.test.ts.
 */
export function makeFakeBusPi(): FakePi {
  const emitted: FakePi["emitted"] = [];
  const appendEntries: FakePi["appendEntries"] = [];
  const handlers = new Map<string, Set<AnyHandler>>();

  const pi = {
    events: {
      emit(channel: string, data: unknown): void {
        emitted.push({ channel, data });
        handlers.get(channel)?.forEach((handler) => handler(data));
      },
      on(channel: string, handler: AnyHandler): () => void {
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => set.delete(handler);
      },
    },
    appendEntry(type: string, payload: unknown): void {
      appendEntries.push({ type, payload });
    },
    on(event: string, handler: AnyHandler): () => void {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    registerCommand(): void {},
    registerShortcut(): void {},
    registerMessageRenderer(): void {},
    sendUserMessage(): void {},
    ui: {},
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    emitted,
    appendEntries,
    trigger(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((handler) => handler(...args));
    },
  };
}
