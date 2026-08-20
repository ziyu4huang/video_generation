/**
 * BTW — side conversation channel — overlay UI component.
 *
 * Adapted from pi-btw (MIT, Dan Bachelder). Renders a focused modal overlay
 * showing the BTW transcript (user/assistant/tool rows) with an input composer
 * at the bottom. Supports scroll, focus toggle, and keyboard-driven submission.
 *
 * The overlay uses TUI Box/Container/Text/Input primitives and is shown/hidden
 * via ctx.ui.custom({overlay:true}).
 */

import {
  Box,
  Container,
  Input,
  Key,
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BtwTranscript,
  BtwTranscriptEntry,
  BtwTranscriptState,
  BtwThreadMode,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

export type OverlayLine =
  | { kind: "plain"; text: string }
  | { kind: "markdown"; text: string; indent: string };

export function buildOverlayTranscript(entries: BtwTranscript, theme: ExtensionContext["ui"]["theme"]): OverlayLine[] {
  if (entries.length === 0) {
    return [{ kind: "plain", text: theme.fg("dim", "No BTW thread yet. Ask a side question to start one.") }];
  }

  const lines: OverlayLine[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = "    ";
  const resultIndent = blockIndent;

  const isBlank = (line: OverlayLine): boolean => line.kind === "plain" && line.text === "";
  const pushBlankLine = () => {
    if (lines.length > 0 && !isBlank(lines[lines.length - 1])) lines.push({ kind: "plain", text: "" });
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (v: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((v: string) => v);
    if (options.blankBefore !== false) pushBlankLine();
    const firstLine = bodyLines.shift() ?? "";
    lines.push({ kind: "plain", text: `${header}${firstLine ? ` ${style(firstLine)}` : ""}` });
    for (const line of bodyLines) lines.push({ kind: "plain", text: `${blockIndent}${style(line)}` });
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; indent?: string; style?: (v: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((v: string) => v);
    if (options.blankBefore !== false) pushBlankLine();
    lines.push({ kind: "plain", text: header });
    for (const line of bodyLines) lines.push({ kind: "plain", text: `${indent}${style(line)}` });
  };

  for (const entry of entries) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) { pushBlankLine(); lines.push({ kind: "plain", text: separator }); }
      continue;
    }
    if (entry.type === "user-message") { pushInlineBlock(userBadge, entry.text, { blankBefore: false }); continue; }
    if (entry.type === "thinking") {
      const h = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
      pushStackedBlock(h, entry.text, { style: (l) => theme.fg("warning", theme.italic(l)) });
      continue;
    }
    if (entry.type === "tool-call") {
      const tLabel = theme.fg("warning", theme.bold(entry.toolName));
      const aLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${tLabel}${aLabel}`);
      continue;
    }
    if (entry.type === "tool-result") {
      const rLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const tLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${rLabel}${tLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (l) => (entry.isError ? theme.fg("error", l) : theme.fg("dim", l)),
      });
      continue;
    }
    if (entry.type === "assistant-text") {
      const h = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
      pushBlankLine();
      lines.push({ kind: "plain", text: h });
      // Render the body as real markdown (headings, bold, code, lists) at
      // render-time width — see wrapOverlayLines. Indented under the badge.
      lines.push({ kind: "markdown", text: entry.text, indent: blockIndent });
    }
  }

  return lines;
}

/**
 * Width-aware rendering of overlay blocks into styled terminal lines.
 *
 * `plain` blocks are wrapped with the existing ANSI-aware wrapper. `markdown`
 * blocks are rendered through pi-tui's `Markdown` component at the current
 * width (so headings/bold/code/lists render naturally AND re-flow on terminal
 * resize), then prefixed with the block's indent. Markdown lines are already
 * wrapped by `Markdown.render(width)`, so they bypass the plain wrapper.
 */
export function wrapOverlayLines(
  blocks: OverlayLine[],
  innerWidth: number,
  markdownTheme: ReturnType<typeof getMarkdownTheme> = getMarkdownTheme(),
): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === "markdown") {
      const contentWidth = Math.max(1, innerWidth - visibleWidth(block.indent));
      const rendered = new Markdown(block.text, 0, 0, markdownTheme).render(contentWidth);
      for (const line of rendered) out.push(block.indent ? `${block.indent}${line}` : line);
    } else if (block.text === "") {
      out.push("");
    } else {
      out.push(...wrapTextWithAnsi(block.text, Math.max(1, innerWidth)));
    }
  }
  return out;
}

function getOverlayTitle(mode: BtwThreadMode): string {
  return mode === "tangent" ? "BTW tangent" : "BTW";
}

// ─── The shortcuts used for focus toggle ─────────────────────────────────────

export const BTW_FOCUS_SHORTCUTS = [Key.alt("/"), Key.ctrlAlt("w")] as const;
const CHROME_LINES = 9;

export function matchesBtwFocusShortcut(data: string): boolean {
  return BTW_FOCUS_SHORTCUTS.some((s) => matchesKey(data, s));
}

// ─── BtwOverlayComponent ──────────────────────────────────────────────────────

export class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly transcript: Container;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly tui: TUI;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private transcriptBlocks: OverlayLine[] = [];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }

  constructor(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    readTranscriptEntries: () => BtwTranscript,
    getStatus: () => string | null,
    getMode: () => BtwThreadMode,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.readTranscriptEntries = readTranscriptEntries;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.onUnfocusCallback = onUnfocus;

    this.modeText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.transcript = new Container();
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => { this.followTranscript = true; this.onSubmitCallback(value); };
    this.input.onEscape = () => { this.onDismissCallback(); };

    this.hintsText = new Text("", 1, 0);

    // SGR mouse reporting for wheel/touchpad
    this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) { this.input.setValue(""); this.tui.requestRender(); return; }
        this.onDismissCallback();
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) { this.onDismissCallback(); return; }
      originalHandleInput(data);
    };

    this.refresh();
  }

  // ─── Private rendering helpers ────────────────────────────────────────────

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(innerWidth: number): string[] {
    return wrapOverlayLines(this.transcriptBlocks, innerWidth);
  }

  private getDialogHeight(): number {
    const terminalRows = process.stdout.rows ?? 30;
    return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) this.followTranscript = false;
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  // ─── Public dispose (cleanup SGR state) ───────────────────────────────────

  dispose(): void {
    this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
  }

  // ─── Mouse scroll handler ─────────────────────────────────────────────────

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) return null;
    const button = Number(match[1]);
    if ((button & 64) !== 64) return null;
    return (button & 1) === 0 ? -3 : 3;
  }

  // ─── Input handling ───────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (matchesBtwFocusShortcut(data)) { this.onUnfocusCallback(); return; }
    const mouseDelta = this.getMouseScrollDelta(data);
    if (mouseDelta !== null) { this.scrollTranscript(mouseDelta); return; }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      this.scrollTranscript(-(matchesKey(data, Key.pageUp) ? Math.max(1, this.transcriptViewportHeight - 1) : 1));
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      this.scrollTranscript(matchesKey(data, Key.pageDown) ? Math.max(1, this.transcriptViewportHeight - 1) : 1);
      return;
    }
    this.input.handleInput(data);
  }

  // ─── Input frame with stable width ────────────────────────────────────────

  private inputFrameLine(dialogWidth: number): string {
    const targetWidth = Math.max(1, dialogWidth - 2);
    const prevFocused = this.input.focused;
    this.input.focused = false; // Render without cursor marker for stable width
    try {
      const renderedLine = this.input.render(targetWidth)[0] ?? "";
      const inputLine = truncateToWidth(renderedLine, targetWidth, "");
      const padding = Math.max(0, targetWidth - visibleWidth(inputLine));
      return `${this.theme.fg("border", "│")}${inputLine}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = prevFocused;
    }
  }

  private fitRenderedLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  }

  // ─── Main render ──────────────────────────────────────────────────────────

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    const wLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const transcriptHeight = Math.max(6, dialogHeight - CHROME_LINES);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, wLines.length - transcriptHeight);
    if (this.followTranscript) { this.transcriptScrollOffset = maxScroll; } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) this.followTranscript = true;
    }

    const visible = wLines.slice(this.transcriptScrollOffset, this.transcriptScrollOffset + transcriptHeight);
    const pad = Math.max(0, transcriptHeight - visible.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary = hiddenAbove || hiddenBelow
      ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
      : this.summaryTextValue.trim();

    const lines: string[] = [this.borderLine(innerWidth, "top")];
    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));
    for (const line of visible) lines.push(this.frameLine(line, innerWidth));
    for (let i = 0; i < pad; i++) lines.push(this.frameLine("", innerWidth));
    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((l) => this.fitRenderedLine(l, width));
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  setDraft(value: string): void { this.input.setValue(value); this.tui.requestRender(); }

  getDraft(): string { return this.input.getValue(); }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((e) => ({ ...e }));
  }

  refresh(): void {
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = entries.filter((e) => e.type === "assistant-text" && !(e as { streaming: boolean }).streaming).length;
    const active = entries.some(
      (e) => (e.type === "thinking" || e.type === "assistant-text" || e.type === "tool-result") && (e as { streaming: boolean }).streaming,
    ) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
    this.summaryText.setText(this.summaryTextValue);

    this.transcriptBlocks = buildOverlayTranscript(entries, this.theme);
    this.transcript.clear();
    for (const block of this.transcriptBlocks) this.transcript.addChild(new Text(block.text, 1, 0));

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = "Scroll wheel ↑↓ PgUp/PgDn · Enter · Alt+/ focus · Esc";
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }
}
