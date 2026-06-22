#!/usr/bin/env bash
# PreToolUse hook (Bash tool): block commands that drift the persistent working
# directory via a top-level `cd <dir>`. The Bash tool's cwd persists across
# calls, and drifting out of the repo root breaks repo-root-relative invocations
# (the mlx venv at python/venv/, run.py — CLAUDE.md: "Invoke from repo root only").
#
# Allowed (no persistent drift): `( cd <dir> && … )` subshell, `cd -`, bare `cd`.
# Blocked: top-level `cd <dir>`, `cd <dir> && …`, `… && cd <dir>`, `cd /abs`, `cd ..`.
# Use instead: `bun run --cwd <dir> <script>`, `git -C <dir> …`, absolute paths.
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
[ -n "$cmd" ] || exit 0

# Strip quoted strings ("…" / '…') and single-level ( … ) subshell groups first,
# so a `cd` inside a quoted arg or a subshell doesn't trip the check.
no_sub="$(printf '%s' "$cmd" | sed -E -e 's/"[^"]*"//g' -e "s/'[^']*'//g" -e 's/\([^()]*\)//g')"

# Drifting cd = `cd` + a path argument (not `cd -`, not bare `cd`), at top level.
if printf '%s' "$no_sub" | grep -qiE '(^|[^[:alnum:]_])cd[[:space:]]+[^-[:space:]&|;)#]'; then
  cat >&2 <<'MSG'
no-cd-drift: blocked a top-level `cd <dir>` (the Bash tool cwd persists across
calls — drifting out of the repo root breaks repo-root-relative paths like the
mlx venv / run.py). Use instead:
  - bun:   `bun run --cwd bun/gui-movie-director <script>`   (--cwd goes AFTER run)
  - git:   `git -C <repo-root> ...`
  - one-shot (no drift): `( cd <dir> && <cmd> )`
  - absolute paths from repo root (no cd at all)
MSG
  exit 2
fi
exit 0
