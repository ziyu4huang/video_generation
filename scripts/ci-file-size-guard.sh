#!/usr/bin/env bash
# ci-file-size-guard.sh — the REMOTE twin of .githooks/pre-commit.
#
# Criterion 3 (CI gates): a PR that adds a file larger than 2 MB must be blocked
# by CI, so a locally-bypassed hook (--no-verify) can't ship a large blob. This
# mirrors the pre-commit hook's logic EXACTLY, including the symlink handling:
# model files under mlx-models/ are symlinks to the external store, stored as
# ~100-byte path-string blobs — so we measure the BLOB size (git cat-file),
# never the dereferenced target (wc -c would read 20 GB and false-positive).
#
# Strategy: one `git cat-file --batch-check` pass finds any oversized blob SHA
# in bulk (fast); only then do we map SHA → path for the error message (the
# common path — zero offenders — never hits the per-file loop).
#
# Usage (from repo root, after checkout):
#   bash scripts/ci-file-size-guard.sh
set -uo pipefail

MAX_BYTES=$((2 * 1024 * 1024))  # 2 MB — identical to .githooks/pre-commit

# git ls-files -s format: "<mode> <sha> <stage>\t<path>". Extract <sha> for BLOB
# entries only — mode 160000 is a submodule gitlink (its "sha" is the submodule
# commit, which is missing from this repo's object DB and would falsely match).
# --batch-check prints "<size> <sha>" per object; awk keeps numeric sizes over
# the limit (the $1 ~ /^[0-9]+$/ guard rejects any non-blob "missing" line).
oversized="$(
	git ls-files -s \
		| awk -F'\t' '{split($1,a," "); if (a[1] != "160000") print a[2]}' \
		| git cat-file --batch-check='%(objectsize) %(objectname)' \
		| awk -v max="$MAX_BYTES" '$1 ~ /^[0-9]+$/ && $1 > max {print $2}'
)"

if [ -z "$oversized" ]; then
	echo "✓ file-size guard: no tracked file exceeds 2 MB"
	exit 0
fi

bad=0
while IFS= read -r sha; do
	[ -z "$sha" ] && continue
	size=$(git cat-file -s "$sha" 2>/dev/null || echo 0)
	path=$(git ls-files -s | grep "$sha" | awk -F'\t' '{print $2}' | head -1)
	if [ "$size" -ge $((1024 * 1024 * 1024)) ]; then
		human="$((size / 1024 / 1024 / 1024)) GB"
	else
		human="$((size / 1024 / 1024)) MB"
	fi
	echo "ERROR: $path is ${human} (limit: 2 MB)" >&2
	bad=1
done <<< "$oversized"

echo "✗ file-size guard: tracked file(s) exceed 2 MB — same limit as .githooks/pre-commit" >&2
exit $bad
