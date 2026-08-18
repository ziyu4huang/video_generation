# webui-simplify spec — 2026-08-18 (user-approved)

## Goal
Make the webui a usable, thin second client (AI chat works again) while
SHRINKING it: fewer tabs, one live transport, one JSONL mirror pattern. The
user doctrine (verbatim intent): webui is a BONUS to the TUI (never conflict
or confuse); BTW is ADDITIONAL; reuse code; no unclear features.

## Section 1 — Chat restore (minimal, Inbox-only)
- Revive the neutered `case "agentic"` dispatch (webui-wiring.ts:816): ops
  prompt/steer/followUp route through the existing `sendMessage` seam
  (text + `deliverAs`), abort routes to `ctx.abort?.()`. NO new mutex code —
  `pi.sendUserMessage` already fires pi's `input` event which IS the gate
  (block => `{action:"handled"}` suppression + `mutex_blocked` broadcast).
- Restore host/context slices: `WebuiHost.sendUserMessage?` already optional
  (re-added by card_send); re-add `abort?(): void` to WebuiSessionCtx.
- Shell: composer (input + Send + Abort) rendered ONLY in the Inbox pane.
  Reuse `isSendEnter` for the IME-safe Enter-to-send. NO new protocol frame:
  the user's text is echoed client-side into the feed on send; assistant
  text already streams as `message_update` frames in the same feed.
- Estimated: ~70 LOC (shell ~40, wiring ~15, slices ~5, tests ~10+).

## Section 2 — Tab consolidation
- Nav: Inbox / Cards / Report / More. The More pane stacks the BTW composer
  + pending list and the Data telemetry card (all functionality, bells,
  polling, persistence kept — relocated only). BTW badge moves to More.
- Hash: `#more` new; `#data` and `#btw` become aliases that resolve to
  `#more` (back-compat deep links). `#card-<id>` and `#inbox/#report`
  unchanged.

## Section 3 — SSE -> WS transport merge
- The standalone reader's live refresh (EventSource '/api/events' +
  heartbeat, render-shell.ts:257 area, render-routes.ts SSE route) is
  replaced by the WS snapshot channel: reader opens WS, receives snapshot +
  `view_opened`/update frames, refetches `/api/view/:id` on change.
- Cut the SSE route + heartbeat + EventSource client (~-100 LOC). The REST
  content routes (`/api/views`, `/api/view/:id`) and the `/raw` contract
  (markdown -> 404) stay untouched.

## Section 4 — JSONL store merge
- New `src/jsonl-mirror.ts`: `persistPath(dir, port, name)`, `appendLine`,
  `loadJsonl(path, cap, revive)`, `compactJsonl(path, keep)`, `clearFile`.
- `report-persist.ts` and `btw-store.ts` become thin adapters (typed
  validation like `buildBtwEntry` stays put). ~-80 LOC, zero behavior change
  (both existing suites must pass unmodified in behavior).

## Implementation decisions (all settled)
- No new frame kind for chat; client-side echo only.
- steer/followUp honored via one seam signature extension
  `(text, opts?: { deliverAs?: "steer" | "followUp" })`.
- Direction doctrine untouched: bells stay client-gated (#1675); BTW bell
  stays ungated (direction 2); mutex watchdog + #1671 ask suspension intact.
- Gates per PR: webui suite + typecheck green locally; push --no-verify with
  GATE BYPASS NOTE (pre-existing deploy-artifact guard drift, cf. #1641+).
