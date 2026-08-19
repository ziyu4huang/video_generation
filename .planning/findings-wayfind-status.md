# Findings: `/wayfind status <effort-name>` — report-only vs agent-triggering

Repo: `/Users/huangziyu/proj/video_generation__superpowers`
Investigated: `bun-apps/pi-agent-ext-wayfind/` + registration in `bun-apps/pi-agent/`.

## TL;DR answer

`/wayfind status <effort-name>` is **purely report-only**. It resolves the effort
(explicit arg, else session's in-memory active effort), runs a `syncChainState`
side-effect (auto-closes tickets whose plan phase completed — a *file* mutation,
not an agent trigger), builds a `statusReport`, and prints it via
`ctx.ui.notify`. It **never** calls `pi.sendUserMessage`, never claims a ticket,
never sets an active-session marker, never injects a "continue the map" prompt.

The agent-triggering mechanism is `pi.sendUserMessage(<prompt>, { deliverAs: "steer" })`.
It is used by: `/wayfind <destination>` (chart), bare `/wayfind` (claim+work
next frontier ticket), `/wayfind seed`, `/wayfind spec`, `/wayfind tickets`,
`/grill me|docs|done --seed-plan|domain`. It is **NOT** used by: `status`,
`sync`, `validate`, `statusbar`, `done` (these only `ctx.ui.notify`).

---

## 1. Registration & subcommand parsing

Registered statically in pi-agent (not run-dir manifest for commands):
`bun-apps/pi-agent/src/static-extensions.ts:59`
`import wayfindExtension from "../../pi-agent-ext-wayfind/extensions/wayfind.ts";`
`:76` `{ name: "pi-agent-ext-wayfind", factory: wayfindExtension },`
(run-dir `manifest.json` references `pi-agent-ext-wayfind` at :69 too).

Entry: `bun-apps/pi-agent-ext-wayfind/extensions/wayfind.ts` → thin shim →
`src/index.ts` → `registerCommands(pi, state, overlay)` (src/index.ts ~line 61).

### Dispatcher: `src/commands.ts:450` — `pi.registerCommand("wayfind", {...})`

Keyword set at `src/commands.ts:47`:
```ts
const WAYFIND_KEYWORDS = new Set(["status", "spec", "tickets", "seed", "sync", "done", "validate", "statusbar"]);
```

Parsing inside the handler (commands.ts:466-505):
```ts
const firstToken = trimmed.split(/\s+/)[0] ?? "";
const isExplicitChart = trimmed.startsWith("--") || WAYFIND_KEYWORDS.has(firstToken);
const activeEffort = state.activeEffortBySession.get(sessionId);
if (trimmed && activeEffort && !isExplicitChart) {      // :474 ambiguous-phrase guard
  ctx.ui.notify(`🧭 ${activeEffort} (active) — showing its status. Use \`/wayfind -- <destination>\` to start a NEW effort.`, "info");
  return handleWayfinderStatus("", ctx);                // :476
}
const bannerEffort = resolveWayfindEffortId(trimmed, () => state.activeEffortBySession.get(sessionId));
if (bannerEffort && firstToken !== "statusbar") ctx.ui.notify(`🧭 ${bannerEffort}`, "info");
if (trimmed.startsWith("--")) { ... return handleWayfinderChart(destination, ctx); }
const [first, ...rest] = trimmed.split(/\s+/);
if (first && WAYFIND_KEYWORDS.has(first)) {
  switch (first) {
    case "status":   return handleWayfinderStatus(remainder, ctx);   // :499-500
    ...
  }
}
return handleWayfinderChart(trimmed, ctx);
```
Note: `/grill` is a separate registration at commands.ts:429.

So `/wayfind status <effort>` → dispatcher banners `🧭 <effort>` → routes to
`handleWayfinderStatus("<effort>", ctx)`. Since `status` is a keyword,
`isExplicitChart` is true → the ambiguous-phrase guard at :474 does NOT fire.

## 2. The `status` handler — `src/commands.ts:302`

```ts
async function handleWayfinderStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sessionId = getSessionId(ctx);
  const effort = resolveEffortOrWarn("status", args, ctx, sessionId);
  if (!effort) return;
  syncChainState(ctx.cwd, effort);
  const r = statusReport(ctx.cwd, effort);
  if (!r) {
    ctx.ui.notify(`No map at .planning/${effort}/map.md`, "warning");
    return;
  }
  ctx.ui.notify(renderStatus(r), "info");
}
```

`resolveEffortOrWarn` (commands.ts:98-110): explicit arg wins, else falls back
to `state.activeEffortBySession.get(sessionId)` (**in-memory, per-process, never
restored on resume** — see comment in handleWayfinderChart :355-361). If neither:
```ts
ctx.ui.notify(`Usage: /wayfind status <effort>  (or run /wayfind <destination> first)`, "warning");
```

Conditionals / behavior branches:
- **Effort arg missing & no active session effort** → usage warning, stop.
- **Map missing** (`readMap` returns null → `statusReport` returns null) →
  `No map at .planning/<effort>/map.md` warning, stop. **This includes archived
  efforts**: after `/wayfind done` the effort moves to `.planning/done/`
  (wayfinder.md:115 "moves the effort into `.planning/done/`; done/ membership
  is itself the complete signal"), so `.planning/<effort>/map.md` no longer
  exists → "No map" warning. There is no `archived` string check in
  handleWayfinderStatus; archiving manifests as the missing-map path.
- **Side-effect before rendering**: `syncChainState(ctx.cwd, effort)`
  (src/chain.ts) auto-closes tickets whose plan phase completed — a disk write
  on the effort dir, not an agent trigger.
- Output shape = `renderStatus(r)` (src/wayfinder.ts:183-201):
```ts
const lines = [
  `[${r.effort}] open ${r.open} · closed ${r.closed} · claimed ${r.claimed} · fog ${r.fog}`,
  `destination: ${r.destination || "(unset)"}`,
];
if (r.frontier.length > 0) { lines.push("frontier:"); for (const t of r.frontier) lines.push(`  ${t.id} ${t.title} [${t.type}]`); }
else if (r.open > 0) { lines.push("frontier: (empty — all open tickets are blocked or claimed)"); }
else {
  lines.push("frontier: (clear — no open tickets; the way is found)");
  if (r.closed > 0) lines.push("  → run `/wayfind done` for the closing ceremony (self-reflect + next-goal note)");
}
```
- **status: closed/complete** is NOT read by `statusReport` (src/wayfinder.ts:165-179
  reads map.tickets/fog only); the lifecycle manifest status surfaces elsewhere
  (`wayfind_effort` tool, `/wayfind statusbar` via `readEffortMeta`). A completed
  effort that's still in place (not yet filed to done/) would render normally.

**No prompt injection anywhere in the status path** — it ends at `ctx.ui.notify`.
It does NOT set `state.activeEffortBySession`, doesn't call `overlay.setActiveEffort`,
doesn't claim tickets.

## 3. The "trigger agent start/continue" mechanism

The only mechanism: **`pi.sendUserMessage(<prompt>, { deliverAs: "steer" })`** —
injects a user message into the session, which the agent then acts on (start/
continue work). Call sites in `src/commands.ts`:

- :92 `startGrill` — `/grill me` and `/grill docs` (grill priming).
- :173 `/grill done --seed-plan` (post-seed handoff message).
- :180 `/grill domain`.
- :255 `/wayfind seed` — "Review the phases, then load the executing-plans ... skill".
- :265 `/wayfind spec` (to-spec) — "Load the `to-spec` skill ...".
- :280 `/wayfind tickets` (to-tickets) — "Load the `to-tickets` skill ...".
- :388 **bare `/wayfind`** — the resume/work path (handleWayfinderChart, :346):
  - :355-361 bugfix comment: active effort is in-memory only, never restored on
    resume → falls back to `adoptMostRecentActiveEffort(ctx.cwd)` (:360), the
    most-recently-modified `status: active` effort **on disk**, notify:
    "No active effort in this session — adopting <effort> ...".
  - :374 `claimNextTicket(ctx.cwd, effort, sessionId)` (src/wayfinder.ts:100) —
    picks `frontier[0]` (open, unblocked, unclaimed), stamps `claimed:`, writes
    ticket file. **This is the auto-pick-next-ticket.**
  - If nothing claimable → notify status + "No unclaimed frontier ticket —
    chart more or resolve claimed ones." (report-only, no steer).
  - On claim: sets `state.activeEffortBySession` (the "active-session marker"),
    `overlay.setActiveEffort`, then :388 `pi.sendUserMessage([...].join("\n"), { deliverAs: "steer" })`
    with: `Working wayfinder ticket <id> "<title>" on effort <effort>. ... read
    <procedures/wayfinder.md>. ... Resolve it (one ticket this session): record
    the answer, then close the ticket + append to the map's Decisions so far.`
- :416 `/wayfind <destination>` (chart) — steer "Charting a wayfinder map for: ...".

### Subcommand classification

| Invocation | sendUserMessage (starts/continues agent work)? | Otherwise |
|---|---|---|
| `/wayfind <destination>` | YES (:416) — chart-the-map steer | creates map dir + sets active effort |
| bare `/wayfind` | YES (:388) — claim+work frontier ticket | adopts effort from disk; status notify if nothing claimable |
| `/wayfind spec` | YES (:265) | — |
| `/wayfind tickets` | YES (:280) | — |
| `/wayfind seed` | YES (:255) | notify-only on refusal |
| `/wayfind sync` | NO | notify closed/skipped (:handleChainSync) |
| `/wayfind validate` | NO | notify (:handleWayfindValidate) |
| `/wayfind done` | NO | notify; closes/files effort; hint to use ask_user_question |
| `/wayfind status` | **NO** | **notify report only** |
| `/wayfind statusbar` | NO | toggles persisted setting |

There is **no `work` or `continue` subcommand**: `continue` is in
`PLACEHOLDER_DESTINATIONS` (commands.ts:50-61), so `/wayfind continue` while no
effort is active → treated as a placeholder warning, not a chart; the "continue
working" affordance is **bare `/wayfind`** (work-the-map claim path above).

`deliverAs: "steer"` = injected mid-conversation steering message (same channel
pi uses for user turns) — that's what makes the agent actually start/continue.

## 4. procedures/wayfinder.md — status + resuming work

`bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md` (162 lines):

- :71 (Blocking/frontier definition): "...the frontier is computed, not rendered
  by a UI — `/wayfind status` does this.) A ticket is **unblocked** when every
  ticket blocking it is closed; the **frontier** is the open, unblocked,
  unclaimed tickets — the edge of the known."
- :105-125 "## Lifecycle status": efforts carry `status` in `map.md` frontmatter
  (`active|paused|...`); :115 "`status: complete` **and** moves the effort into
  `.planning/done/`... location-as-status"; :118 "(there is no separate
  'abandoned' value). `wayfind_effort status` reports the..."; :121-125
  "**Prefer the `wayfind_effort status` tool action for inventory/audit** over
  ... Subagents have no `/wayfind` slash commands, so `status` is their
  [surface]".
- :135-141 charting flow (reserved-keyword note: `/wayfind -- <destination>`).
- :150 (work-the-map / resume): "2. Choose the ticket. If the user named one,
  use it. Otherwise take the first frontier ticket in order. **Claim it**: add a
  `claimed:` line before any work." — i.e. the documented resume mechanism is
  claiming the first frontier ticket (what bare `/wayfind` does mechanically).
- :160 closing ceremony via `/wayfind done [effort]` ("the command refuses if
  open tickets remain").

Per the doc, resuming an effort = bare `/wayfind` (or `/wayfind -- <effort>`-less
adoption) → claim frontier ticket → work per :150; `status` is explicitly the
read-only inventory surface.

## Session-state notes

- Active effort marker: `state.activeEffortBySession` (src/state.ts) — in-memory,
  per-process; cleared on session_shutdown via `endGrillForSession`
  (commands.ts end). NOT persisted; resume of a "closed" GUI session does not
  restore it (hence the disk-adoption fallback).
- One extra subtlety: bare non-keyword phrase while an effort IS active
  (commands.ts:474) redirects to status instead of charting — status can thus be
  an accidental destination of other inputs, still report-only.
