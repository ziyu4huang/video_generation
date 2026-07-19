# R3 — Probe TTS + word-timing wiring for word-pop captions

type: research
claimed: pi-agent
blocked by: (none)
status: closed

## Question

Word-pop captions (the chosen caption style) need **word-level timing data** —
each word synced to when it's spoken in the TTS audio. Two things must work:

1. **TTS generation** — does `run.py tts` (edge-tts) get called by the pipeline
   for narration, and does it capture WordBoundary events?
2. **Word-timing handoff** — does the word-timing data flow from the TTS asset
   into compose-remotion's `Story.tsx` so it can render word-pop?

Also probe the **remotion browser dependency** (Not-yet-specified #1):
compose-remotion needs a headless browser (Chromium/Puppeteer) to render. Does
the environment have one? Check:
- `bun-apps/pi-agent-ext-movie-director/remotion/` package.json — does it list
  puppeteer/playwright? Is a browser installed?
- Try a trivial remotion render — does it fail on "no browser found"?

This is the highest-risk probe: if the browser isn't available, word-pop
captions are blocked and we fall back to ffmpeg-burned captions (losing kinetic
typography).

## How to resolve

- Read `runpy_tts.ts` — does it expose word-timing, or just a wav file?
- Read `Story.tsx` — what input shape does it expect for word-pop (word array
  with timestamps)?
- Check `remotion/package.json` + try `bun --cwd remotion run render` (or
  equivalent) on a trivial composition — does a browser resolve?
- Check `providers.ts` compose-remotion path — how does it invoke the render?
- Surface three facts: (a) TTS word-timing captured? (b) word-pop input wired?
  (c) browser available?

## Answer (closed 2026-07-19 — RESOLVED via subagent probe)

Three facts surfaced:

**(a) TTS does NOT capture word-timing — design gap + runtime missing.**
`tts.py` uses `edge_tts.Communicate(...).save()` which only writes audio.
WordBoundary events (emitted via `communicate.stream()`) are discarded. Zero
`WordBoundary` references in the python tree. Also: **edge-tts is not
installed** in the venv → TTS command is entirely non-functional right now.

**(b) wordCues contract is wired, but no one fills it — half-pass.**
`Story.tsx` accepts `wordCues?: WordCue[]` and renders `WordPopCaption` when
`captionStyle==="tiktok"`. `remotion.ts` passes `edit.wordCues` through to
`remotion-props.json`. BUT **no orchestrator ever sets `edit.wordCues`** →
`WordPopCaption` never renders (the guard `wordCues && wordCues.length > 0`
is always false). A `cuesFromWhisper()` exists but feeds SRT/subtitle_gen, not
`edit.wordCues`.

**(c) Browser IS available — not a blocker.** Chrome.app + Playwright chromium
resolve. `@remotion/renderer` needs its own chromium (first render triggers a
one-time download) unless `REMOTION_BROWSER_EXECUTABLE` points at Chrome.app.

### Verdict
Word-pop captions are **achievable but need code** (not browser-blocked).
Four gaps: (1) install edge-tts, (2) `tts.py` capture WordBoundary → words.json,
(3) `runpy_tts.ts` parse wordCues, (4) edit_decisions builder inject
`edit.wordCues`.

**Shortcut**: skip edge-tts WordBoundary entirely — use `whisper words.json`
(which already has per-word start/end via `cuesFromWhisper(mode:"words")`)
and wire THAT into `edit.wordCues` instead of SRT. Bypasses the edge-tts
install + Python changes. Generate narration audio (macOS `say` offline, or
edge-tts once installed), run whisper, convert to wordCues.
