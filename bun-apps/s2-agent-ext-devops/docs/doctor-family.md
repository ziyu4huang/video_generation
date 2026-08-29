# Doctor family — which diagnostic surface when

Slash-surface-consistency ticket 05 (2026-08-30): five live diagnostic
surfaces, each answering a DIFFERENT question. This table is the single
routing surface ("which doctor do I run?"); each surface's own docs stay
authoritative for its flags and output.

## The five surfaces (re-measured 2026-08-30, main `6f55366f`)

| Surface | Command | Owns | Run when the symptom is… |
|---|---|---|---|
| **sh doctor** | `bun bun-apps/s2-agent/src/cli-sh.ts doctor` (deployed: the dist's `doctor` face) | Deploy/machine boundary: deploy mode, entry resolution, extension-set completeness for that mode, host deps, provider keys, patch set | "the tree/dist won't boot or loads the wrong extension set" — mode/entry/deps level |
| **ext doctor** | `bun bun-apps/s2-agent/src/cli.ts ext doctor` | The extension registry: every registered extension, its version, and the tools it contributes | "extension X or its tools are missing from the registry" — registration level |
| **cli doctor** | `bun bun-apps/s2-agent/src/cli.ts cli doctor [--json] [--fix]` | Fresh-machine boundary conditions: runtime, repo layout, run-dir manifest, MLX output/models dirs, flux2 binary, vault, LM Studio reachability, provider/model | "fresh clone / new machine — is everything this repo needs actually here?" |
| **session doctor** | `bun bun-apps/s2-agent-ext-devops/src/session-doctor-cli.ts [--target dev\|deploy]` | The LIVE session: boots the target with the shared tools-active probe (ONE-probe doctrine), model lane, TUI banner | "it boots but behaves wrong" — toolless session (`tools: []` in requests), wrong model in the footer, deploy-vs-dev behavioral drift |
| **debug-s2-session** (skill) | read `skills/debug-s2-session/SKILL.md` | The METHOD layer: when-to-reach-for routing + payload inspection recipe; backed by session-doctor-cli | you are an agent deciding WHICH surface to reach for, or you need to see the actual API request payload |

## Symptom → doctor (quick routing)

- Fresh machine / after setup scripts → **cli doctor** (boundary conditions).
- `./s2-agent.sh` or a dist boots wrong / mode suspect → **sh doctor**.
- A tool or extension absent from the palette/registry → **ext doctor**.
- Session runs but tools are missing in the actual provider request, or the
  model lane looks wrong → **session doctor** (dev or deploy target).
- "Which surface even applies?" or "show me the request payload" → read the
  **debug-s2-session** skill.

## Deliberate non-goals

- NOT merging the surfaces: each guards a different boundary (offline
  statics vs live probe vs registry enumeration); one mega-doctor would
  hide which check class failed.
- NOT a sixth surface: this doc is routing only; it owns no checks.
