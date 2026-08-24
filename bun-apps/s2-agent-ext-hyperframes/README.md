# s2-agent-ext-hyperframes

Vendored **HyperFrames skill family** — 8 skills bundled as a pi extension package, so they load from the repo (project/ext-bundled source) instead of ambient user-level `~/.pi/agent/skills/` symlinks.

## Skills

| Skill | Role |
|---|---|
| `hyperframes` | Router/entry point — intent interview, route pick, sibling dispatch |
| `hyperframes-cli` | CLI dev loop — init/scaffold, lint/check/preview/render, cloud |
| `hyperframes-core` | Composition contract — `data-*` timing, tracks, determinism |
| `hyperframes-registry` | Registry blocks/components install & wiring |
| `hyperframes-creative` | Design direction — palettes, typography, narration, frame presets |
| `hyperframes-keyframes` | Seek-safe keyframe authoring (GSAP/WAAPI/…) |
| `hyperframes-animation` | Motion knowledge base — rules, blueprints, adapters |
| `media-use` | "Agent Media OS" — resolve/generate BGM/SFX/voice/image + ledger |

The 8 skills cross-reference each other by slash-name (`/hyperframes-core`) and
relative path (`../media-use/references/...`), so they MUST stay in one
`skills/` root — do not split them across packages.

## Provenance

- Source: [`heygen-com/hyperframes`](https://github.com/heygen-com/hyperframes), plugin "core-skills" (all 8 skills), installed via the `npx skills` CLI on **2026-08-08**.
- Folder hashes at vendor time are recorded in `~/.agents/.skill-lock.json` (v3 lock manifest of the skills CLI).
- Copied verbatim (byte-identical, symlinks dereferenced) from `~/.claude-custom/skills/` — including bundled binaries: 20 mp3 SFX (`media-use/audio/assets/sfx/`, see its CREDITS.md) and OFL-licensed `.woff2` fonts (`hyperframes-creative/frame-presets/code-editorial/`).

## Re-vendor procedure

1. Update the source install: `npx skills add heygen-com/hyperframes@core-skills -g -y` (refreshes `~/.claude-custom/skills/`).
2. Re-copy the 8 trees over `skills/` (dereference): `for s in <name>; do cp -R ~/.claude-custom/skills/$s skills/$s; done`.
3. `bun test` — `tests/skills-manifest.test.ts` guards frontmatter validity and binary-asset presence, so a partial copy fails loudly.

## Registration

- `package.json` → `pi.skills: ["./skills"]` (dev/source mode)
- `s2-agent/run-dir/manifest.json` → `skills[]` + `binarySkills[]` (binaries must be extracted to real disk in embedded/exe deploys) + `staticExtensions[]`
- `s2-agent/src/static-extensions.ts` → static factory entry
- `s2-agent/src/registry-config.ts` → `skills: true` for the sh deploy (copied verbatim by `ext-build.ts`)
- The extension factory (`src/index.ts`) is a **no-op** — the package carries skills, not tools.

## Runtime deps (NOT vendored)

Node 22+, FFmpeg, `heygen` CLI (media-use first-run), Python (creative/media-use scripts). Vendoring moves the knowledge, not the toolchains.
