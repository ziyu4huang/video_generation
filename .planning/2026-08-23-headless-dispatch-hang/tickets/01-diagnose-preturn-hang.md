# Ticket 01 — diagnose & bound the headless pre-send hang (B1)

Status: open

## Problem

Headless `./s2-agent.sh --model deepseek/deepseek-v4-flash --no-session --mode
json -p "<prompt>"` intermittently-but-content-keyed hangs BEFORE the first
model request: zero JSON events on stdout, 0% CPU, ZERO TCP connections (no
deepseek socket — the request is never sent), main thread parked in `kevent64`
(`sample` output captured at `/tmp/live-smoke/sample.txt`, 2026-08-23).
Reproduces in bare mode (`--no-extensions --no-skills`) → core loop or the
s2-agent startup patches (`bun-apps/s2-agent/src/patches/`), NOT extensions or
skills. Full evidence matrix in the map's Context.

## Repro (fastest known)

```bash
./s2-agent.sh --model deepseek/deepseek-v4-flash --no-session --mode json \
  --no-extensions --no-skills \
  -p "reply with exactly: <hello world>"   # hangs; control without <> passes
```

Hang = zero bytes on stdout after 75–100s. Control prompts (same flags) settle
in 3–22s. 4/4 vs 6/6 on 2026-08-23; see the map's fog for the two anomalies
(bracketed pass at 17:00, bracket-free hang 2/2 at 18:00).

## Approach

1. Localize the await: bare mode narrows to the pi SDK
   (`@earendil-works/pi-coding-agent` / `pi-agent-core` / `pi-ai`) plus the
   s2-agent startup patches. Instrument the `-p` path (or bisect the patches)
   to find the code that examines user-message content before the first
   provider request.
2. Characterize the trigger predicate precisely (brackets? certain tokens?
   length × state?) — the two fog anomalies say "angle brackets" is not the
   whole story.
3. Fix if tractable; otherwise bound it: the pre-send phase must complete or
   fail within a configurable deadline so `-p` never hangs silently.

## Done when

- [ ] Root cause named at file:line with a reproducing unit/faux-transport
      test (no live model needed if the await is local).
- [ ] Headless `-p` either never hits the await, or aborts with a diagnostic
      within the deadline.
- [ ] The oneshot-smoke CI gate gains a prompt shape that would have caught
      this (it currently probes trivial prompts only).

## Bounds

- No live-model requirement in the shipped test (faux transport), per repo
  test discipline.
