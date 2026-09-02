# zcode-generate-slide-video

Render an archify-style HTML slide deck (a `*.slides/` dir of `slide-N.html`) into a
**narrated MP4**: per-slide voice-over, Ken Burns motion, crossfade transitions.
Zero npm dependencies — the CLI drives headless Chrome, macOS `say`, and ffmpeg.

## Usage (from the repo root)

```bash
# server serving the deck (slide JS expects http; Range support needed for
# <video> seek bars — use serve.py, NOT plain `python3 -m http.server`)
python/venv/bin/python bun-apps/zcode-generate-slide-video/scripts/serve.py 8123 &

bun bun-apps/zcode-generate-slide-video/src/cli.ts --deck output/slides-deck
# → output/slides-deck/slides-that-argue.slides-narrated.mp4
```

Deck layout expected:

```
<deckDir>/
  deck.config.json        # archify deck manifest (used to derive narration if no narration.json)
  narration.json          # optional hand-written script (recommended)
  <name>.slides/          # exported slide HTML (archify_export_pptx writes this)
    slide-1.html …
```

`narration.json` shape (one entry per slide; `file` names are matched against the
discovered slides, order works too):

```json
{
  "slides": [
    { "file": "slide-1.html", "text": "Spoken over the title slide." },
    { "file": "slide-8.html", "query": "embed=1", "revealLabels": true,
      "text": "Spoken over the pipeline diagram." }
  ]
}
```

- `query` — extra URL params for the slide (e.g. the archify viewer's `embed=1`
  chrome-free mode).
- `revealLabels` — archify diagram slides only: the viewer hides relationship
  labels below 1.25× zoom (MAP reading depth), so a static render would lose
  them. This writes a **temporary render copy** with `detailLevel()` floored at
  READ, screenshots that, and removes the copy. The shipped slide file is never
  modified.

## Pipeline

1. **discover** — `slide-\d+.html` files in the `*.slides/` dir, numeric order.
2. **frames** — headless Chrome screenshots at `--width × --height`.
3. **voice** — `say -v <voice> -r <rate>` per slide → ffmpeg → 48 kHz WAV.
4. **segments** — still + narration per slide: lead silence, narration, tail
   silence; Ken Burns zoom (alternating in/out); min duration `--seconds`.
5. **concat** — `xfade` video + `acrossfade` audio transitions, global fade
   in/out, `+faststart`.

## Flags

`--deck` (required) · `--out` · `--narration` · `--voice Samantha` · `--rate 175` ·
`--seconds 3` · `--lead 0.5` · `--tail 0.9` · `--transition 0.6` ·
`--width 1920 --height 1080 --fps 30` · `--base-url http://127.0.0.1:8123` ·
`--slides-dir` · `--keep` (keep work dir) · `--reuse` (reuse frames + wavs).

Full list: `--help`.

## Requirements

macOS (`say`), ffmpeg/ffprobe (`brew install ffmpeg`), Chrome (auto-detected;
override with `CHROME_BIN`), and an HTTP server for the deck (`--base-url`).

## Tests

```bash
bun test bun-apps/zcode-generate-slide-video/
```

Covers the pure seams: arg parsing/config defaults, transition offset math,
narration derivation and slide matching.
