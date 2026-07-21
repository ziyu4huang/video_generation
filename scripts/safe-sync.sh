#!/usr/bin/env bash
# safe-sync — a sourced shell function that replaces the manual
# `git pull && git reset --hard origin/main && git submodule update` ritual.
#
# WHY THIS EXISTS:
#   The bare `git reset --hard origin/main` discards any UNPUSHED local commits
#   on main (it wiped commit 0a4af623 on 2026-07-21). safe-sync NEVER resets: it
#   delegates to scripts/sync-repo.sh, which is ff-only, refuses a diverged tree,
#   and never destroys unpushed work. A pre-flight guard also warns loudly if the
#   current branch or main has unpushed commits, so you remember to push first.
#
# INSTALL (one line in ~/.zshrc):
#   [ -f "$HOME/proj/video_generation/scripts/safe-sync.sh" ] && \
#     source "$HOME/proj/video_generation/scripts/safe-sync.sh"
#
# USAGE:
#   safe-sync                 # fetch + ff current branch + sync submodules (pinned SHAs)
#   safe-sync --full          # everything to latest default branch (main + submodules)
#   safe-sync --pull          # merge instead of ff
#   safe-sync --rebase        # rebase current branch onto its upstream
#   safe-sync --no-submodules # skip the recursive submodule sync
#   safe-sync --dry-run       # show what would run, mutate nothing
#   (any other args are passed through to scripts/sync-repo.sh)

safe-sync() {
	local root sync cur
	root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
		echo "safe-sync: not inside a git repo" >&2
		return 1
	}
	sync="$root/scripts/sync-repo.sh"
	if [ ! -f "$sync" ]; then
		echo "safe-sync: $sync not found (is this the video_generation repo?)" >&2
		return 1
	fi
	cur="$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)"

	# Pre-flight: warn about unpushed work on the current branch and on main.
	# (sync-repo.sh won't discard it anyway — ff-only — but this reminds you to push.)
	__safe_sync_warn_ahead "$root" "$cur"
	__safe_sync_warn_ahead "$root" "main"

	echo "→ safe-sync: running sync-repo.sh $* (ff-only, NEVER resets --hard)"
	echo "  repo: $root"
	if [ "$cur" = "main" ]; then
		echo "  reminder: main is a pristine origin/main mirror; commit work to feature branches."
	fi
	echo
	"$sync" "$@"
}

# Print a warning if <branch> has unpushed commits relative to its upstream.
# Silent when <branch> has no upstream or is up to date. (Internal helper.)
__safe_sync_warn_ahead() {
	local root="$1" branch="$2" upstream ahead
	[ -n "$branch" ] || return 0
	upstream="$(git -C "$root" rev-parse --abbrev-ref --symbolic-full-name "${branch}@{u}" 2>/dev/null)" || return 0
	ahead="$(git -C "$root" rev-list --count "${branch}@{u}..${branch}" 2>/dev/null)" || return 0
	if [ "${ahead:-0}" -gt 0 ] 2>/dev/null; then
		echo "⚠  $branch is $ahead commit(s) AHEAD of $upstream (unpushed local work)." >&2
		echo "    sync-repo.sh will NOT discard it (ff-only), but push first if you want it on the remote:" >&2
		echo "      git push -u origin $branch" >&2
		echo >&2
	fi
}
