# WebUI + TUI mix patterns — best-practices catalog (2026-08-18)

Doctrine (user, verbatim intent): the TUI is self-contained and stays the
center of heavy jobs. The WebUI is a BONUS that resolves human readability;
it NEEDS pi-agent-core and is CONSTRAINED by the TUI, never the reverse.

Sources: (a) pi's own docs (local, v0.84.2 — citable); (b) model knowledge of
real hybrid-agent systems (claude-code-webui / happy-coder, opencode, gptme,
Aider, Weav/agent-cli, Codex CLI, Cline/Continue — NOT live-verified this
session; treat specifics as leads, not citations).

## The pattern catalog (P1-P9)

P1 TUI self-containment — the TUI never degrades if the webui is absent,
disabled, or killed. pi is "a minimal terminal coding harness"; every extra
capability is an extension ("No MCP / No sub-agents / No permission popups /
No plan mode — build with extensions", pi README). Our webui honors this:
lazy unref'd server, optional host seams (guarded `?.`), extension removable
with zero core impact.

P2 Single-writer arbitration — exactly one writer per turn. The host `input`
event IS the mutex gate; a blocked writer gets broadcast-only feedback
(mutex_blocked frame + one TUI warning line). Watchdog force-releases a
stalled web driver; pending ask-user questionnaires suspend it (#1671).
TUI keeps priority: the browser may drive, the TUI always can.

P3 Faces over one core — pi itself ships three faces over AgentSession: the
TUI, RPC mode ("enables headless operation ... useful for embedding the
agent in other applications, IDEs, or custom UIs", docs/rpc.md), and the JSON
event stream (docs/json.md). Our webui is a fourth face implemented as an
in-process extension: no second agent process, but bound to the host session
lifecycle — constrained by the TUI by construction. This is the "pi-agent
especially" answer: never fork the brain; add a face.

P4 Readability lane — the web earns its place only where a terminal cannot:
markdown-rendered reports, sandboxed HTML iframes, fullscreen + standalone
/raw pages, hash deep links (#card-<id>, #report). Long agent output becomes
human-readable instead of scrollback. (Aider's one-way browser announce and
happy-coder's mobile-readable transcripts are the same lane.)

P5 One transcript, replay on connect — a single session store is the source
of truth; every face reads the same event stream (the rpc/json modes emit the
same events). Connect-time snapshot replay means a browser opened mid-session
sees full history; JSONL mirrors persist reports/BTW across restarts.

P6 Notification bridge, client-gated — TUI->webui projections are optional:
bells for cards/views ring ONLY when a browser client is connected (#1675);
the one-line "webui ready" banner is the only unconditional notify.

P7 Reverse-question queue is additional — browser->agent questions that do
not need a live turn queue as BTW entries (bell = direction 2, ungated),
drained by the agent via tool; folded into the secondary More tab (#1684) so
the primary surfaces stay Inbox/Cards/Report.

P8 Local trust boundary — loopback-only binding, DNS-rebinding-safe origin
guard, token auth available but off. The webui is a personal mirror, not a
service.

P9 One of each — dedup ruthlessly: ONE live transport (WS; SSE cut #1685),
ONE JSONL mirror pattern (PR4), one bell implementation, one hash router.
Reuse is a doctrine, not a preference.

## Audit vs the repo (2026-08-18, main 317d9de)

| Pattern | Status | Evidence |
|---|---|---|
| P1 | conforms | lazy server; optional seams; #1675 gates |
| P2 | conforms | input-event mutex; #1671 ask suspension |
| P3 | conforms | in-process extension face; no second brain |
| P4 | conforms | reports/#raw/deep links; MORE possible below |
| P5 | conforms | session store + snapshot replay + JSONL |
| P6 | conforms | client-gated bells #1675 |
| P7 | conforms | BTW in More #1684 |
| P8 | conforms | loopback + origin guard |
| P9 | 3/4 | SSE cut #1685; JSONL merge = PR4 (pending) |

## Gap candidates (user-decision-gated, not yet committed)

- G1 markdown-in-chat-feed: assistant message_update text renders as plain
  lines in the Inbox feed; the readability lane argues for markdown there
  (Report tab already has the marked+sandbox pipeline to reuse).
- G2 mobile pass: shell CSS is desktop-first; happy-coder's core value is
  "check the agent from your phone" — a responsive pass would deliver that.
- G3 multi-session index: one port = one session today; opencode-style index
  of running sessions would need cross-process discovery (new architecture).
- G4 transcript search/filter: the feed is append-only; no find-across-turns.
