import { afterAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildSessionJournal } from "../src/child-session-journal.js";

/** Real in-memory pi sessions for round-trip proof (no LLM anywhere). */
async function makeSessionWithEntries(userText: string) {
  const { createAgentSession, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const piAi = await import("@earendil-works/pi-ai");
  const { createAssistantMessageEventStream } = piAi;
  const home = mkdtempSync(join(tmpdir(), "journal-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "journal-cwd-"));
  const { session } = await createAgentSession({
    cwd,
    agentDir: home,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.create(cwd, home),
  });
  // Scripted one-turn stream → real user + assistant entries in the transcript.
  const stream = (): AssistantMessageEventStream => {
    const s = createAssistantMessageEventStream();
    const partial = {
      role: "assistant",
      content: [{ type: "text" as const, text: "ack" }],
      api: "fake",
      provider: "fake",
      model: "fake",
      usage: {
        input: { tokens: 1, cost: { total: 0, amount: 0, currency: "usd" } },
        output: { tokens: 1, cost: { total: 0, amount: 0, currency: "usd" } },
        totalTokens: 2,
        cost: { total: 0, amount: 0, currency: "usd" },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    s.push({ type: "start", partial });
    s.push({ type: "text_start", contentIndex: 0, partial } as never);
    s.push({ type: "text_end", contentIndex: 0, content: "ack", partial } as never);
    s.push({ type: "done", reason: "stop", message: partial } as never);
    s.end();
    return s;
  };
  session.agent.streamFunction = stream;
  await session.agent.prompt(userText);
  return { session, home, cwd };
}

const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function freshHome(): string {
  const h = realpath(mkdtempSync(join(tmpdir(), "journal-state-")));
  homes.push(h);
  return h;
}

function realpath(p: string): string {
  return require("node:fs").realpathSync(p);
}

describe("child-session-journal (self-arc-27 t01)", () => {
  test("round-trip: persist → load returns parseable entries that restore an equivalent session", async () => {
    const home = freshHome();
    const journal = createChildSessionJournal({ home });
    const { session, cwd } = await makeSessionWithEntries("remember CODEWORD ZEBRA-77");
    journal.persist("scout", session);

    const file = journal.pathFor("scout");
    assert.ok(existsSync(file), "journal file written");
    const raw = readFileSync(file, "utf-8");
    assert.ok(raw.split("\n")[0].includes('"type":"session"'), "first line is the session header");

    const loaded = journal.load("scout");
    assert.ok(loaded && loaded.length >= 2, "header + ≥1 entry");
    const text = JSON.stringify(loaded);
    assert.ok(text.includes("CODEWORD ZEBRA-77"), "user text survives");
    assert.ok(text.includes("ack"), "assistant text survives");

    // Restore through pi's own API: entries reproduce the transcript + id.
    const { SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const restored = SessionManager.inMemory(cwd, undefined, loaded);
    assert.equal(restored.getSessionId(), session.sessionManager.getSessionId());
    assert.ok(restored.getEntries().length === session.sessionManager.getEntries().length);
    void SettingsManager;
  });

  test("charset guard: hostile or invalid names never touch the fs", () => {
    const home = freshHome();
    const journal = createChildSessionJournal({ home });
    for (const name of ["a/b", "../x", ".hidden", "sp ace", "x".repeat(65)]) {
      // load on a non-existent path returns undefined WITHOUT creating dirs
      assert.equal(journal.load(name), undefined, name);
      assert.equal(existsSync(join(home, ".pi", "subagents", "sessions")), false, name);
    }
  });

  test("corrupt journal degrades to undefined; headerless-but-nonempty too", () => {
    const home = freshHome();
    const journal = createChildSessionJournal({ home });
    const dir = join(home, ".pi", "subagents", "sessions");
    mkdirx(dir);
    writeFileSync(join(dir, "broken.jsonl"), "{not json\n");
    writeFileSync(join(dir, "headerless.jsonl"), `${JSON.stringify({ type: "message", role: "user" })}\n`);
    assert.equal(journal.load("broken"), undefined);
    assert.equal(journal.load("headerless"), undefined);
  });

  test("retention: oldest journals evicted beyond the last-N cap", async () => {
    const home = freshHome();
    const journal = createChildSessionJournal({ home, maxEntries: 3 });
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const dir = join(home, ".pi", "subagents", "sessions");
    mkdirx(dir);
    for (let i = 0; i < 5; i++) {
      const sm = SessionManager.inMemory();
      writeFileSync(join(dir, `n${i}.jsonl`), JSON.stringify(sm.getHeader()) + "\n");
      // distinct mtimes so the sweep order is deterministic
      utimesSync(join(dir, `n${i}.jsonl`), new Date(1_000_000 + i * 1000), new Date(1_000_000 + i * 1000));
    }
    // drive the private sweep through persist (public surface only)
    const session = { sessionManager: SessionManager.inMemory() } as never;
    journal.persist("trigger", session);
    const remaining = readdirSync(dir).sort();
    assert.equal(remaining.length, 3, `cap enforced, got: ${remaining.join(",")}`);
    assert.ok(!remaining.includes("n0.jsonl") && !remaining.includes("n1.jsonl"), "oldest evicted");
    assert.ok(remaining.includes("trigger.jsonl"), "newest kept");
    void existsSync;
  });
});

function mkdirx(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
