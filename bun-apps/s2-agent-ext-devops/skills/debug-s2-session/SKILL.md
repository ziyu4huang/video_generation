---
name: debug-s2-session
description: 'Use when an s2-agent session looks broken in a way config inspection cannot explain — tools missing from the provider request ("toolless session"), the TUI boots but the model lane is wrong, a deployed dist behaves differently from the dev tree, or you need to SEE the actual API request payload a session sends. Triggers include "session has no tools", "tools: [] in the request", "deploy toolless", "verify a deploy''s tool surface", "which models can I actually use here", "TUI footer shows the wrong model", "inspect the request the agent sends". Backed by session-doctor-cli.ts.'
---

# Debugging an s2-agent Session (tool surface / model lane / request payload)

> One of FIVE diagnostic surfaces — for "which doctor do I run?", see the
> routing table at `bun-apps/s2-agent-ext-devops/docs/doctor-family.md`
> (this skill is the method layer; session-doctor-cli below is its probe).

## Overview

Deploys #1921→#1946 booted TOOLLESS sessions — `tools: []` in every provider
request, zero tool calls, all five deploy-e2e gates green — because nothing
observed the ACTIVE toolset. `session-doctor-cli.ts` is the hardened version
of the tmux + logging-proxy loop that caught it, runnable against BOTH
targets:

- **dev** — `bun bun-apps/s2-agent/src/cli.ts` (source tree)
- **deploy** — the frozen dist launcher `s2-agent.sh` inside the deploy root's
  `current` dir (same target `verify-deploy-e2e` probes)

## When to use

- Suspect a toolless or half-toolless session (deploy or dev).
- After a deploy, before trusting it (belt-and-braces next to
  `verify-deploy-e2e`, which runs the same probe as a gate).
- TUI boots but shows the wrong model, or the footer/banner looks off.
- "Which models can I ACTUALLY use on this machine?"

**Not for:** adding models to the catalog (`s2-agent-model-catalog-update`),
devops git/PR phases (`devops-workflow`).

## Quick reference

```bash
# Tool-surface check (default) — shared tools-active probe, core builtins
bun bun-apps/s2-agent-ext-devops/src/session-doctor-cli.ts                     # dev
bun bun-apps/s2-agent-ext-devops/src/session-doctor-cli.ts --target deploy    # dist
bun bun-apps/s2-agent-ext-devops/src/session-doctor-cli.ts --target deploy \
  --provider deepseek --model deepseek-v4-flash-vision-exp                     # speed lane

# Usable models — static readiness (stored/custom/env) + localhost probe
bun bun-apps/s2-agent-ext-devops/src/session-doctor-cli.ts --models

# Interactive-boot smoke in a REAL pty (tmux): trust prompt + footer + model lane
bun bun-apps/s2-agent-ext-devops/src/session-doctor-cli.ts --target deploy --tui
```

Always the DIRECT CLI path. `bun bun-apps/s2-agent/src/cli.ts session-doctor`
is the bare-token trap: the pi parser treats the unknown token as a PROMPT and
starts a model-waiting agent session (the 2026-08-24 11-minute "hang" RCA).

## The failure classes

| verdict / class | signature | meaning |
|---|---|---|
| `TOOLLESS` | `total=0` | nothing registered — the session never loaded a toolset |
| `ACTIVE-SET-WIPED` | registered>0, `activeCount=0` | `setActiveTools([])` class (#1946) |
| `CORE-BUILTINS-MISSING` | `missing≠[]` (read/write/edit/bash) | builtin-union half-fix class (#1952) |
| `SURFACE-REGRESSED` | `getActiveTools:false` / threw | ExtensionAPI no longer exposes the read |
| `skip` | probe never fired, fast provider/auth fail | not a session bug — provider lane, rerun with `--provider` |

`gate seam` in the note is tool-gate's self-report; **absent is expected**
since #1952 (the ext is default-off) — absence is not a failure.

## Why the probe reads at before_agent_start (do not "simplify" this)

The doctor shares ONE probe with deploy-e2e's `tools-probe`,
`deploy-probe-e2e`, and `doctor --smoke` (`src/tools-active-probe.ts`).
`-e` probes load BEFORE tool-gate (order 190, last), so a `session_start`
read returns the PRE-gate state — a false green. The probe listens on
`before_agent_start` and defers the read through an UN-awaited 250ms
`setTimeout` so every handler (including tool-gate's) has run. If you ever
write another tool-surface check, reuse this probe instead.

## The TUI loop (`--tui`)

Boots the target in tmux, answers the trust prompt with Enter, and asserts
the footer renders the REQUESTED model lane. Two timing facts:

- The settings `defaultProvider` hijacks a bare `--model`; the doctor always
  passes `--provider` explicitly, and a footer showing a different model is a
  FAIL ("model lane never rendered").
- The `Tool gate: N/M active` banner (when the ext is enabled) renders 5s
  AFTER session_start and auto-dismisses 8s later — never gate a poll loop on
  "some footer appeared", and never treat banner absence as failure on
  current builds (default-off).

## Seeing the actual request payload (logging-proxy trick)

To inspect what a session really sends (tools array, system prompt,
params), point the provider at a logging proxy via a throwaway `-e` ext:

```ts
// proxy-ext.ts — register the provider with a baseUrl override
export default (pi) => {
  pi.registerProvider("deepseek", { baseUrl: "http://127.0.0.1:9999/v1", api: "openai-completions" });
};
// bun bun-apps/s2-agent/src/cli.ts -e proxy-ext.ts --provider deepseek --model <id> -p "hi"
```

Run any request-logging reverse proxy on :9999 (e.g. a tiny Bun
`Bun.serve` that logs and forwards). This is how `tools: []` was first
observed (2026-08-24).

## Model listing (`--models`)

`--list-models` shows the FULL baked catalog regardless of credentials.
`--models` filters it by STATIC readiness — `~/.pi/agent/auth.json` stored
credentials, `~/.pi/agent/models.json` custom-provider apiKeys, provider env
keys (`PROVIDER_ENV_KEYS`, vendored from pi-ai's `env-api-keys.js` — its
exports map is closed), and a `GET <baseUrl>/models` reachability probe for
localhost providers. It deliberately does NOT shell `auth check`: that path
took >120s for the full provider set and interleaves extension banners,
which is how a v1 regex mis-parsed every provider as not_ready.

Known limits: google-vertex ADC-based auth is not detected; readiness of a
remote provider means "a key is present", not "the key is valid" — a live
invalid key still shows ready until a real call fails.
