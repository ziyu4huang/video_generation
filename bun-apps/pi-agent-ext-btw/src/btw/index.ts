/**
 * BTW — side conversation channel — feature registration.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder). Registers the `/btw` commands,
 * keyboard shortcuts, message renderer, session event handlers, and context
 * filter that together implement the BTW side-conversation workflow.
 *
 * Usage:
 *   import { registerBtwFeature } from "./btw";
 *   export default (pi) => { registerBtwFeature(pi); ... };
 */

import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BtwDetails, type BtwThreadMode } from "./types";
import { BTW_MESSAGE_TYPE } from "./constants";
import { BtwEngine } from "./session";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { BTW_FOCUS_SHORTCUTS } from "./overlay";
import { BTW_COMMAND_CHANNEL, isBtwCommand } from "./webui-events";

export function registerBtwFeature(pi: ExtensionAPI): BtwEngine {
  const engine = new BtwEngine(pi);

  // ── Message renderer ────────────────────────────────────────────────────
  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content = typeof message.content === "string" ? message.content : "[non-text btw message]";

    const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", theme.bold("[BTW]")), 0, 0));
    // Render the body as real markdown (headings, bold, code, lists) instead
    // of raw text — mirrors the host's default CustomMessageComponent.
    box.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));

    if (expanded && details) {
      const detailLines = [
        `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
      ];
      if (details.usage) {
        detailLines.push(`tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`);
      }
      box.addChild(new Text(theme.fg("dim", detailLines.join("\n")), 0, 0));
    }
    return box;
  });

  // ── Context filter: strip BTW messages from main agent context ──────────
  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((msg: { role: string; customType?: string }) => {
        return !(msg.role === "custom" && msg.customType === BTW_MESSAGE_TYPE);
      }),
    };
  });

  // ── Session lifecycle ───────────────────────────────────────────────────
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    engine.setLatestCtx(ctx);
    await engine.restoreThread(ctx);
    engine.emitThreadEvent();
  });

  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    engine.setLatestCtx(ctx);
    await engine.restoreThread(ctx);
    engine.emitThreadEvent();
  });

  pi.on("session_shutdown", async () => {
    await engine.shutdown();
  });

  // webui panel commands (user-only surface; D2 — no new tools registered)
  pi.events?.on(BTW_COMMAND_CHANNEL, (data: unknown) => {
    if (!isBtwCommand(data)) return;
    void engine.handleWebuiCommand(data);
  });

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus while leaving it open.",
      handler: async () => {
        engine.toggleOverlayFocus();
      },
    });
  }

  // ── Commands ────────────────────────────────────────────────────────────
  pi.registerCommand("btw", {
    description: "Continue a side conversation in a focused BTW modal. Add --save to also persist a visible note.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw", args, ctx);
    },
  });

  pi.registerCommand("btw:tangent", {
    description: "Start or continue a contextless BTW tangent in the focused BTW modal.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:tangent", args, ctx);
    },
  });

  pi.registerCommand("btw:new", {
    description: "Start a fresh BTW thread with main-session context. Optionally ask the first question immediately.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:new", args, ctx);
    },
  });

  pi.registerCommand("btw:clear", {
    description: "Dismiss the BTW modal/widget and clear the current thread.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:clear", args, ctx);
    },
  });

  pi.registerCommand("btw:inject", {
    description: "Inject the full BTW thread into the main agent as a user message.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:inject", args, ctx);
    },
  });

  pi.registerCommand("btw:summarize", {
    description: "Summarize the BTW thread, then inject the summary into the main agent.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:summarize", args, ctx);
    },
  });

  pi.registerCommand("btw:model", {
    description: "Show, set, or clear the BTW-only model override.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:model", args, ctx);
    },
  });

  pi.registerCommand("btw:thinking", {
    description: "Show, set, or clear the BTW-only thinking override.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await engine.dispatchBtwCommand("btw:thinking", args, ctx);
    },
  });

  return engine;
}
