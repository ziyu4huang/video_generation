// proto-picker.ts — ticket 04 throwaway.
//
// Validates the UX *feel* of the "editor-driven coexistence" model from ticket 02:
//   - type freely into the editor line;
//   - typing "/" opens a filterable picker below it;
//   - keep typing → the list filters LIVE (claude-code feel);
//   - ↑/↓  or  Ctrl-P / Ctrl-N  navigate the list;
//   - Enter selects; Esc closes the picker (buffer stays); Ctrl-C exits.
//
// Scope: FEEL only. Ticket 02 already proved pi-tui's real CustomEditor +
// overlay achieve this against the vendored 0.82.0 surface; this script just
// makes the interaction model concrete for human reaction (→ drives the
// component API in ticket 05). Not wired to pi-tui on purpose — cheap throwaway.
//
// Run:  bun run .planning/2026-07-25-i-think-it-works-fine-let-s-continue-study-next-/assets/proto-picker.ts

const ITEMS: ReadonlyArray<readonly [string, string]> = [
  ["/help", "show keybindings & help"],
  ["/subagents", "open the subagent viewer panel"],
  ["/clear", "clear the conversation history"],
  ["/model", "switch the active model"],
  ["/preset", "apply a prompt preset"],
  ["/agents", "list / manage sub-agents"],
  ["/cost", "show token & cost totals"],
  ["/review", "request a code review"],
  ["/compact", "compact the conversation context"],
  ["/undo", "undo the last assistant turn"],
  ["/diff", "show uncommitted changes"],
  ["/init", "initialize project context"],
  ["/resume", "resume a previous session"],
  ["/theme", "change the color theme"],
];

const stdout = process.stdout;
const enc = new TextEncoder();
const write = (s: string): void => {
  stdout.write(enc.encode(s));
};

// --- interaction state -------------------------------------------------------
let buffer = ""; // the "editor" line
let sel = 0; // selected index into the filtered list
let open = false; // picker visible?

function filtered(): typeof ITEMS {
  const q = buffer.startsWith("/") ? buffer.slice(1).toLowerCase() : "";
  if (q === "") return ITEMS;
  return ITEMS.filter(([name]) => name.toLowerCase().includes(q));
}

function clearScreen(): void {
  write("\x1b[2J\x1b[H");
}

function render(): void {
  clearScreen();
  const list = filtered();
  if (sel > list.length - 1) sel = Math.max(0, list.length - 1);

  write("\x1b[1mpi picker — editor-driven coexistence prototype\x1b[0m\n");
  write("\x1b[2m(type / to open the picker · ↑/↓ or Ctrl-P/N navigate · Enter selects · Esc closes · Ctrl-C exits)\x1b[0m\n\n");

  // editor line + block cursor
  write("Editor > " + buffer + "\x1b[7m \x1b[0m\n\n");

  if (open && buffer.startsWith("/")) {
    if (list.length === 0) {
      write("  \x1b[2m— no matches —\x1b[0m\n");
    } else {
      for (let i = 0; i < list.length; i++) {
        const [name, desc] = list[i];
        if (i === sel) write(`❯ \x1b[36m\x1b[1m${name}\x1b[0m  \x1b[2m${desc}\x1b[0m\n`);
        else write(`  \x1b[37m${name}\x1b[0m  \x1b[2m${desc}\x1b[0m\n`);
      }
    }
  } else {
    write("  \x1b[2m(picker closed — keep typing; type / to open)\x1b[0m\n");
  }
}

// --- raw key handling --------------------------------------------------------
function cleanup(): void {
  try {
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  write("\x1b[0m\r\n");
}

function selectCurrent(): void {
  const list = filtered();
  if (list.length === 0) return;
  const chosen = list[sel][0];
  render();
  write(`\n\n\x1b[32m✓ selected: ${chosen}\x1b[0m\n`);
  cleanup();
  process.exit(0);
}

const dec = new TextDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  const data = dec.decode(chunk);
  switch (data) {
    case "\x03": // Ctrl-C
      cleanup();
      process.exit(0);
      break;
    case "\r": // Enter
      if (open) selectCurrent();
      break;
    case "\x1b": // bare Esc
      if (open) {
        open = false;
        render();
      }
      break;
    case "\x1b[A": // ↑
    case "\x10": // Ctrl-P
      if (open) {
        sel = Math.max(0, sel - 1);
        render();
      }
      break;
    case "\x1b[B": // ↓
    case "\x0e": // Ctrl-N
      if (open) {
        const list = filtered();
        sel = Math.min(list.length - 1, sel + 1);
        render();
      }
      break;
    case "\x7f": // Backspace / Delete
      buffer = buffer.slice(0, -1);
      if (!buffer.startsWith("/")) open = false;
      render();
      break;
    default:
      // single printable char → append + maybe open
      if (data.length === 1 && data >= " " && data < "\x7f") {
        const wasOpen = open;
        buffer += data;
        if (buffer.startsWith("/")) {
          open = true;
          if (!wasOpen) sel = 0; // first open → top of list
        }
        render();
      }
      // else: swallow other control / multi-byte sequences
  }
});

// --- boot --------------------------------------------------------------------
if (!process.stdin.isTTY) {
  process.stderr.write("This prototype needs an interactive terminal (TTY).\n");
  process.stderr.write("Run it directly in your shell, not via a pipe.\n");
  process.exit(1);
}

process.stdin.setRawMode(true);
process.stdin.resume();
render();
