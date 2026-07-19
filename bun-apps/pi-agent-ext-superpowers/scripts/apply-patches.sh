#!/usr/bin/env bash
########################################
# apply-patches.sh — apply every migrations/*.patch substitution to the
# superpowers skill files. Idempotent: rows whose old-string is no longer
# present are skipped, so re-running after an upstream sync is a no-op once
# converged. Modeled on MLX's vendor_patches.py (declarative table + applier).
########################################
set -euo pipefail

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # pi-agent-ext-superpowers/
shopt -s nullglob
patches=("$PKG"/migrations/*.patch)
[[ ${#patches[@]} -gt 0 ]] || { echo "no migrations/*.patch found"; exit 0; }

applied=0; skipped=0
for patch in "${patches[@]}"; do
  while IFS=$'\t' read -r file old new; do
    # skip comments and blanks
    case "$file" in ''|\#*) continue ;; esac
    target="$PKG/$file"
    if [[ ! -f "$target" ]]; then
      echo "warn: $file missing — skipped" >&2
      continue
    fi
    # idempotent: old string no longer present → nothing to do
    if ! grep -qF -- "$old" "$target"; then
      skipped=$((skipped + 1))
      continue
    fi
    perl -i -pe "s{\\Q$old\\E}{$new}g" "$target"
    echo "patched $file: $old -> $new"
    applied=$((applied + 1))
  done < "$patch"
done
echo "apply-patches: $applied substituted, $skipped already-present"
