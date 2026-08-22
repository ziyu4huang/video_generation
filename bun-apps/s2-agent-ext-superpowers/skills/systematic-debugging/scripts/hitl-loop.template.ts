#!/usr/bin/env bun
// Human-in-the-loop reproduction loop.
// Copy this file, edit the steps below, and run it.
// The agent runs the script; the user follows prompts in their terminal.
//
// Usage:
//   bun hitl-loop.ts
//
// Everything above the STAGES marker is the HITL library — identical in every
// wizard. Do not hand-edit it. Author the per-step stages below the marker.
//
// At the end, captured values are printed as KEY=VALUE for the agent to parse.
// `ask` prints its value back to the terminal, where the agent reads it — so
// capture observations, and leave signing in to the user as a `step`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// ──────────────────────────────────────────────────────────────────────────
// HITL library — delightful, consistent UX. Identical across every wizard.
// ──────────────────────────────────────────────────────────────────────────

// The .sh detected color support via tput on a real terminal; Bun's equivalent
// is `process.stdout.isTTY` — piped output (e.g. the agent reading the
// transcript) stays plain, so KEY=VALUE parses cleanly.
const COLOR = process.stdout.isTTY === true;
const BOLD = COLOR ? "\x1b[1m" : "";
const DIM = COLOR ? "\x1b[2m" : "";
const RESET = COLOR ? "\x1b[0m" : "";
const BLUE = COLOR ? "\x1b[34m" : "";
const GREEN = COLOR ? "\x1b[32m" : "";
const YELLOW = COLOR ? "\x1b[33m" : "";
const RED = COLOR ? "\x1b[31m" : "";

// Author sets this at the top of the stages section.
let TOTAL_STAGES = 0;

let _stageIndex = 0;
const ENV_FILE = process.env.ENV_FILE ?? ".env";
const WRITTEN_ENV: string[] = []; // KEYs written to ENV_FILE this run
const WRITTEN_SECRET: string[] = []; // secret NAMEs set this run
const SKIPPED: string[] = []; // things we couldn't do (e.g. gh missing)

// _clear — wipe the terminal so only the current step is on screen. No-op when
// output isn't a terminal, so piped logs stay readable.
function _clear(): void {
  if (!COLOR) return;
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

// readLine "Prompt" — read one line from the human. `hidden` disables echo the
// way bash `read -rs` does. Returns null on EOF / Ctrl-C / Ctrl-D — ask and
// ask_secret abort the loop then; pause and confirm treat it as Enter / No.
async function readLine(prompt: string, hidden = false): Promise<string | null> {
  process.stdout.write(prompt);
  if (hidden && process.stdin.isTTY) {
    let buf = "";
    return await new Promise<string | null>((resolve) => {
      const done = (value: string | null): void => {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(value);
      };
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === "\n" || ch === "\r") return done(buf);
          if (ch === "" || ch === "") return done(null); // Ctrl-C, Ctrl-D
          if (ch === "" || ch === "\b") buf = buf.length > 0 ? buf.slice(0, -1) : "";
          else buf += ch;
        }
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    });
  }
  return await new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
    rl.once("close", () => resolve(null));
  });
}

// die "msg" — print a warning and exit 1. The failure path: a mid-loop EOF or
// Ctrl-C means the human is gone and the loop cannot finish — the Bun port of
// `set -euo pipefail`'s exit-on-failure for the prompt helpers.
function die(msg: string): never {
  warn(msg);
  process.exit(1);
}

// banner "Title" — opening frame: what this wizard does.
async function banner(title: string): Promise<void> {
  _clear();
  console.log(`\n${BOLD}${BLUE}  ${title}${RESET}`);
  console.log(`${DIM}  ${TOTAL_STAGES} stages${RESET}\n`);
  console.log(`${DIM}  You drive the browser; this wizard tells you exactly what to do and`);
  console.log("  captures the values you copy back. Stop any time with Ctrl-C and re-run");
  console.log(`  later — it remembers values already saved.${RESET}`);
  await pause("Ready to start?");
}

// stage "Name" — clear the screen, then announce a stage and show progress.
// Clearing keeps only the current step on screen.
function stage(name: string): void {
  _clear();
  _stageIndex += 1;
  console.log(`\n${BOLD}${BLUE}▸ Stage ${_stageIndex}/${TOTAL_STAGES} · ${name}${RESET}`);
}

// say "..." — a plain instruction line.
function say(text: string): void {
  console.log(`  ${text}`);
}

// step "..." — a numbered-feeling action the human takes in the browser.
function step(text: string): void {
  console.log(`  ${BLUE}•${RESET} ${text}`);
}

function note(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}

function warn(text: string): void {
  console.log(`  ${YELLOW}⚠ ${text}${RESET}`);
}

// open_url URL — open in the human's browser, cross-platform incl. WSL.
const BROWSER_LAUNCHERS = ["wslview", "explorer.exe", "xdg-open", "open"] as const;
function open_url(url: string): void {
  console.log(`  ${GREEN}↗ opening${RESET} ${url}`);
  for (const launcher of BROWSER_LAUNCHERS) {
    const result = spawnSync(launcher, [url], { stdio: "ignore" });
    if (result.error !== undefined) continue; // launcher missing — next (bash `command -v`)
    if (result.status === 0) return; // launched
    // found but failed — keep trying the next launcher, like bash's elif-chain
  }
  warn(`couldn't open a browser — visit it manually: ${url}`);
}

// pause "msg" — wait for the human to confirm they've done the manual part.
// EOF is tolerated (bash `read -r _ || true`): a scripted run just proceeds.
async function pause(msg = "Press Enter to continue"): Promise<void> {
  await readLine(`  ${DIM}${msg}${RESET} `);
}

// confirm "question" — y/N gate; returns true on yes.
async function confirm(question: string): Promise<boolean> {
  const reply = await readLine(`  ${YELLOW}? ${question} [y/N] ${RESET}`);
  return reply !== null && /^[Yy]/.test(reply);
}

// _existing KEY — current value of KEY in ENV_FILE, if any.
function _existing(key: string): string {
  try {
    if (!existsSync(ENV_FILE)) return "";
    const lines = readFileSync(ENV_FILE, "utf8").split("\n");
    const line = lines.filter((l) => l.startsWith(`${key}=`)).pop();
    return line ? line.slice(key.length + 1) : "";
  } catch {
    return "";
  }
}

// ask KEY "Prompt" — read a value for the KEY. Returns the answer; capture it:
//   const KEY = await ask("KEY", "Prompt");
// Offers the existing .env value as a default on re-runs (Enter keeps it).
// Visible input (non-secret).
async function ask(key: string, prompt: string): Promise<string> {
  const current = _existing(key);
  const text = current
    ? `  ${BOLD}${prompt}${RESET} ${DIM}[Enter keeps current]${RESET} `
    : `  ${BOLD}${prompt}${RESET} `;
  const input = await readLine(text);
  if (input === null) die(`${prompt} — no input (stdin closed); aborting`);
  return input !== "" ? input : current;
}

// ask_secret KEY "Prompt" — like ask, but input is hidden.
async function ask_secret(key: string, prompt: string): Promise<string> {
  const current = _existing(key);
  const text = current
    ? `  ${BOLD}${prompt}${RESET} ${DIM}[Enter keeps current]${RESET} `
    : `  ${BOLD}${prompt}${RESET} `;
  const input = await readLine(text, true);
  if (input === null) die(`${prompt} — no input (stdin closed); aborting`);
  return input !== "" ? input : current;
}

// write_env KEY VALUE — upsert KEY=VALUE into ENV_FILE (creates it; replaces
// any existing line). Idempotent.
function write_env(key: string, value: string): void {
  const raw = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const lines = raw === "" ? [] : raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing-newline artifact
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  const content = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  writeFileSync(ENV_FILE, `${content}${key}=${value}\n`);
  WRITTEN_ENV.push(key);
  console.log(`  ${GREEN}✓ wrote${RESET} ${key} → ${ENV_FILE}`);
}

// set_secret NAME VALUE — set a GitHub Actions repo secret via gh. Falls back
// to a warning (and records it) if gh is unavailable or unauthenticated.
function set_secret(name: string, value: string): void {
  const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  if (auth.error === undefined && auth.status === 0) {
    const result = spawnSync("gh", ["secret", "set", name], {
      input: value,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (result.error === undefined && result.status === 0) {
      WRITTEN_SECRET.push(name);
      console.log(`  ${GREEN}✓ set${RESET} GitHub secret ${name}`);
      return;
    }
  }
  SKIPPED.push(`GitHub secret ${name} (set it manually: gh secret set ${name})`);
  warn(`skipped GitHub secret ${name} — gh not ready; set it later`);
}

// set_var NAME VALUE — set a GitHub Actions repo variable (non-secret).
function set_var(name: string, value: string): void {
  const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  if (auth.error === undefined && auth.status === 0) {
    const result = spawnSync("gh", ["variable", "set", name, "--body", value], {
      stdio: "ignore",
    });
    if (result.error === undefined && result.status === 0) {
      console.log(`  ${GREEN}✓ set${RESET} GitHub variable ${name}`);
      return;
    }
  }
  SKIPPED.push(`GitHub variable ${name}`);
  warn(`skipped GitHub variable ${name} — gh not ready; set it later`);
}

// finish — clear, then a closing summary of everything configured.
function finish(): void {
  _clear();
  console.log(`\n${BOLD}${GREEN}  ✓ Setup complete${RESET}`);
  if (WRITTEN_ENV.length > 0) note(`wrote ${WRITTEN_ENV.length} value(s) to ${ENV_FILE}: ${WRITTEN_ENV.join(" ")}`);
  if (WRITTEN_SECRET.length > 0) note(`set ${WRITTEN_SECRET.length} GitHub secret(s): ${WRITTEN_SECRET.join(" ")}`);
  if (SKIPPED.length > 0) {
    console.log("");
    warn("still to do by hand:");
    for (const item of SKIPPED) note(`  - ${item}`);
  }
  console.log("");
}

// ──────────────────────────────────────────────────────────────────────────
// STAGES — author this section. One stage() per step the human takes.
// Replace the example below. Set TOTAL_STAGES to match the stages you write.
// In the Bun library, ask/ask_secret RETURN the value (capture it in a
// const); the KEY argument is what the .env default lookup and write_env use.
// ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES = 2;
await banner("Reproduce the bug");

// ── Example stages: replace with your real reproduction steps ─────────────
stage("Reproduce the error");
say("We'll drive the app to the error you hit.");
open_url("http://localhost:3000");
step("Sign in to the app.");
step("Click the 'Export' button.");
pause("Confirm the error is showing.");

stage("Capture the symptom");
const ERRORED = await ask("ERRORED", "Did it throw an error? (y/n)");
const ERROR_MSG = await ask("ERROR_MSG", "Paste the error message (or 'none'):");
// ──────────────────────────────────────────────────────────────────────────

// Captured values — printed as KEY=VALUE for the agent to parse: the ported
// "--- Captured ---" block of the old hitl-loop.template.sh. `finish` comes
// last (identical wizard closing); in a piped run `_clear` is a no-op, so the
// KEY=VALUE lines above stay in the output stream the agent reads.
console.log("");
console.log("--- Captured ---");
console.log(`ERRORED=${ERRORED}`);
console.log(`ERROR_MSG=${ERROR_MSG}`);
finish();
