# 01 — Royalty-free music source

## Question

Which royalty-free music source should the new `music_generation` provider fetch
from — one that is **programmatically fetchable without a paid key**, **license-
clean for the produced video**, and **searchable by mood/energy/duration**?

The destination fixed music as "royalty-free stock via network" (Pixabay-style).
This research ticket picks the concrete source. Candidates to evaluate (verify
current 2026 reality, don't assume):

- **Pixabay Music API** — what OpenMontage's samples literally cite ("royalty-free
  Pixabay strings / piano"). Is there a free API key? Search-by-mood/genre? Direct
  `.mp3` download URL? Attribution requirement?
- **Free Music Archive (FMA)** — Creative-Commons catalog; API availability +
  license variety (CC-BY vs CC-NC — NC is unusable).
- **Incompetech (Kevin MacLeod)** — large royalty-free library, no key, direct
  URLs, CC-BY (attribution). Search/filter mechanism?
- **Internet Archive / ccMixter** — public-domain + CC pools.
- **YouTube Audio Library** — royalty-free but not API-fetchable (likely out).

Settle in the same pass:

- **License posture:** prefer CC0 / Pixabay-license / CC-BY (attribution recordable
  in `publish_log`). Reject anything NC/ND.
- **Search interface:** does the source let us query by `{mood, energy, duration}`
  so the provider can map a scene_plan's tone to a track? Or is it a fixed curated
  list the provider picks from by tag?
- **Caching/offline-after-fetch:** confirm the file lands under the project
  `assets/` dir so a re-run (and `--offline`) reuses it.

### Context (pre-gathered — don't re-investigate)

- The destination (map.md) fixed **royalty-free stock via network**, explicitly
  rejecting cloud generative (Suno/Udio) and offline/user-supplied.
- Compose already mixes whatever `edit.audio.music.src` points at
  (`src/compose_motion.ts:280-296`, `mixAudioOnto` :360) — so a cached local file
  path is the contract the chosen source must satisfy.
- OpenMontage's story samples all cite Pixabay royalty-free scores; matching that
  is the low-risk default, but confirm the API is actually usable without a paid
  tier.

type: research
claimed: pi-agent
blocked by: —
status: closed

## Resolution (closed 2026-07-19)

**Primary: Pixabay Music API. Fallback: Openverse (keyless). FMA ruled out.**

- **Pixabay Music API** — free REST API; searches music by mood/genre; returns
  JSON with direct media URLs; **free API key** (signup, no payment); **Pixabay
  Content License = commercial + non-commercial OK, no attribution required**
  (they request you surface the source — record it in `publish_log` anyway, for
  honesty). JS SDK exists. This is exactly what OpenMontage's samples cite
  ("royalty-free Pixabay strings / piano").
- **Openverse API** (CC Catalog) — **keyless** REST aggregator over CC-licensed
  + public-domain audio, filterable by license. Use as the keyless fallback, but
  verify per-track license + download URL (it indexes other providers). Good for
  CC0/CC-BY picks when no Pixabay key is set.
- **Free Music Archive — OUT.** Public API shut down (server load); no
  programmatic access. Do not build on FMA.
- **Incompetech** — keep as a documented manual fallback (CC-BY, attribution),
  not the primary API path.

**Fact [04](04-music-provider-integration.md) depends on:** the provider takes a
free Pixabay API key (env `PIXABAY_API_KEY`); when absent, fall back to Openverse
(keyless). License is recordable with **no schema change** — a free-text
attribution field in `publish_log` suffices. This retires the map's
"attribution/license metadata" fog as a non-issue.

## Revision (2026-07-19, at ticket 04)

**The source category was INVERTED by the user at ticket 04** ("MLX + open-source
+ free music"): away from network stock (Pixabay/Openverse) toward **local
generative music** — Meta MusicGen via mlx-audiocraft, CC-BY-4.0, fully on-device.
This keeps the destination (a working music source) but reverses the *how*. The
Pixabay/Openverse findings above remain valid as a documented alternative if a
network-stock path is ever wanted; the in-effect source for this effort is the
local MusicGen provider landed in [04](04-music-provider-integration.md).
