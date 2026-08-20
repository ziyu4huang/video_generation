# PRD — s2-agent-ext-power-tool

## Problem

Debugging a pi agent's own runtime is guesswork without introspection. Which
extensions loaded? Which tools are actually registered, and what do they cost per
request? Where did the context window go? And when a session goes wrong — the agent
retrying the same call, drowning in one tool's errors, or drifting after twenty
turns — nothing surfaces *that* either.

## Solution

Two complementary diagnostic modes, both callable by the agent on itself:

- **Static** — report the agent's current state (loaded extensions/tools/skills,
  registered lifecycle hooks, above-editor widget state, token distribution, health
  findings) at call time, with no session history.
- **Dynamic (failure pathology)** — detect *how* the agent is failing this session,
  from a hook-fed, session-scoped ring buffer of tool calls.

Every analyzer is a pure function over a typed input, so the diagnostics are
testable without the SDK; every tool accepts `self_test: true` to run against a
fixture with no live session.

Alongside the tools, `schema-cost` is exported as a standalone submodule: the
static per-tool schema-token estimator, also consumed by `s2-agent`'s
`schema-cost` CLI command and by `s2-agent-ext-tool-gate`.

## Where the inventory lives

Deliberately **not** in this document. The tool list, each tool's parameters, and
each analyzer's checks live in the code and are authoritative there — see the
table in `README.md` § "Where the facts live". Five files once each claimed a
different tool count; only the code was right, so the code is now the only place
that says.

## Key dependencies

- `s2-agent` — registered as a static extension (`extensions/power-tool.ts`).
- Otherwise self-contained: no external services, no network.
