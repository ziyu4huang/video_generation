---
name: deterministic-edit-dispatch
description: Use when a controller or orchestrator session must change repo files through dispatched subagent children that abort mid-flight (~40 deaths in one arc) — children asked to "apply this change" freelance re-derived anchors, mangle template literals, run scripts twice duplicating insertions, or die leaving half-applied state.
---

# Deterministic edit dispatch

Move ALL judgment to the controller; children become mechanical executors that transcribe and run exactly what they are given. A child that only transcribes a heredoc and runs one command survives in 1–2 turns; a child that "understands" the edit dies mid-thought and leaves half-applied state. `/tmp` artifacts survive child deaths — only the report turn is ever lost.

## Core pattern

Before: "apply this change to src/x.ts" → child re-derives anchors, edits by intuition, dies at turn 9 of an edit sequence.
After: controller authors an exact pair-replacement script; child pastes it, runs one command, reports raw output.

## Procedure

1. **Recon first, read-only** — dispatch "transcriber" children: `grep -n` / `sed -n` exact anchors, verbatim transcription of raw output, zero analysis ("run exactly this, transcribe raw output").
2. **Controller authors the edit script** — one `/tmp/apply-XX.ts` with a `rep(from, to, tag)` helper printing HIT/MISS/AMBIG per tag, guarded so re-runs are idempotent:

```ts
function rep(t: string, from: string, to: string, tag: string): string {
  if (t.includes(to)) { console.log(`ALREADY ${tag}`); return t; }
  const n = t.split(from).length - 1;
  if (n === 0) { console.log(`MISS ${tag}`); process.exitCode = 1; return t; }
  if (n > 1) { console.log(`AMBIG ${tag} (${n})`); process.exitCode = 1; return t; }
  console.log(`HIT ${tag}`);
  return t.replace(from, to);
}
// wr(path, content) for new files, same ALREADY guard.
```

3. **MISS protocol** — grep the fragment from the live file, adjust ONE pair, `git checkout -- <file>` to reset, re-run ONCE. Never let a child improvise a fix for a miss.
4. **Double-run contamination** — when the anchor survives inside its own replacement, collapse adjacent duplicates (`block+block -> block`) after confirming counts with `grep -c`.
5. **Template-literal files** (shell JS inside backticks) — authored insertions contain NO backticks, NO backslashes, NO dollar-brace; escape sequences stay double-backslash in source.
6. **Ship steps as single-command transcriber children** — `git add X && git commit -m "..." && git push ... && gh pr create ... | tail -1`; the command output IS the report.
7. **Long gates inside the same block** — `bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates > log 2>&1; echo EXIT=$?; tail -1 log` (or nohup + poll loop when a death mid-CI is possible).
8. **Verify landed state before the next dispatch** — a 1-turn state-check child runs `grep -c` sentinels plus the suite's REAL pass/fail lines. Never assume the previous child landed anything.

## Common mistakes

- Letting the recon child analyze ("looks like the function moved") instead of transcribe — analysis is where children die.
- Writing the apply script into the repo — it belongs in `/tmp`; it is disposable, the tree stays clean.
- Re-running without the ALREADY guard after a partial application — duplicates every insertion.
- Trusting a child's "done" claim — step 8 exists because dying children report optimistically.

## Provenance

> Provenance: webui-v3 arc 2026-08-17/18 (22 PRs shipped through ~40 child aborts, PRs #1572-#1604; zero freelanced edits); RED+GREEN promotion tests 2026-08-18; candidate `.planning/knowledge/deterministic-edit-dispatch.md` (consumed on promotion). Complements dispatch-recovery (shape here vs budget there).
