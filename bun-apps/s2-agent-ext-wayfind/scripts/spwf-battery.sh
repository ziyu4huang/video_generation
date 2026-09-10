#!/bin/bash
# spwf-battery — the live-drive A/B battery (spwf-drive-ab promotion).
# 6 cases x 2 models, neutral frozen prompts, triple model pinning.
# PIN: the deployed immutable version dir (env-overridable; must contain the
# F2 bootstrap directive — grep ext/superpowers/ext.cjs for "check the
# available skills list" before trusting any deploy).
set -u
cd /Users/huangziyu/proj/video_generation__superpowers
eval "$(grep -h '^export ZAI_API_KEY=' ~/.zshrc)"
PIN="${S2_DRIVE_DEPLOY:-/Users/huangziyu/proj/dist/s2-agent-sh/darwin-arm64/0.10.3+gc172fd3}"
D=bun-apps/s2-agent-ext-wayfind/scripts/drive-case.ts
mkdir -p output/spwf-battery/scratch output/spwf-battery/glm output/spwf-battery/gemma

C1_PROMPT='Does the exact phrase '"'"'You have superpowers'"'"' appear anywhere in your context, including any injected instruction blocks? Reply with exactly YES or NO and nothing else.'
C2_PROMPT='I want to add a demo flag to output/spwf-battery/scratch/hello.ts (create the file if it does not exist) that echoes its value.'
C3_PROMPT='Implement is_leap_year(year) as a new scratch module under output/spwf-battery/scratch/ with tests.'
C5_PROMPT='I'"'"'m mid-effort under .planning/ and can'"'"'t remember whether my settled grill output should go through to-spec or to-tickets — which wayfind flow fits, and what should I read?'
C8_PROMPT='The grill settled and the spec exists but there is no plan yet - what is the next artifact to produce, and which skill owns producing it? Name the owning skill and its package.'

run_model () {
  M=$1; PP=$2; PM=$3; OUT=$4
  echo "=== column $M ==="
  # C1
  bun $D --case C1 --leg deployed --dist $PIN --pin-provider $PP --pin-model $PM --cap 300 --out $OUT/C1.json --prompt "$C1_PROMPT" --expect-reply YES
  # C2 (wipe scratch first)
  rm -f output/spwf-battery/scratch/hello.ts
  bun $D --case C2 --leg deployed --dist $PIN --pin-provider $PP --pin-model $PM --cap 300 --out $OUT/C2.json --prompt "$C2_PROMPT" --expect-read brainstorming
  # C3 (wipe scratch first)
  rm -rf output/spwf-battery/scratch/leap* output/spwf-battery/scratch/is_leap*
  bun $D --case C3 --leg deployed --dist $PIN --pin-provider $PP --pin-model $PM --cap 300 --out $OUT/C3.json --prompt "$C3_PROMPT"
  # C4 (wipe scratch first; -ns + exclude env)
  rm -f output/spwf-battery/scratch/hello.ts
  bun $D --case C4 --leg deployed --dist $PIN --pin-provider $PP --pin-model $PM --cap 300 --out $OUT/C4.json --env "PI_SUPERPOWERS_SKILL_EXCLUDE=!,brainstorming" --extra-arg -ns --prompt "$C2_PROMPT" --forbid-read brainstorming
  # C5
  bun $D --case C5 --leg deployed --dist $PIN --pin-provider $PP --pin-model $PM --cap 300 --out $OUT/C5.json --prompt "$C5_PROMPT" --expect-read-any to-spec,to-tickets
  # C8
  bun $D --case C8 --leg deployed --dist $PIN --pin-provider $PP --pin-model $PM --cap 300 --out $OUT/C8.json --prompt "$C8_PROMPT" --expect-reply writing-plans
}

run_model glm zai glm-5.3 output/spwf-battery/glm
run_model gemma lm-studio google/gemma-4-12b output/spwf-battery/gemma
echo "BATTERY DONE"
