#!/usr/bin/env bash
#
# Non-interactive installer for Squirrel (鼠鬚管) + the rime-liur Boshiamy
# (嘸蝦米) schema. Equivalent to running the upstream interactive installer
#    curl -fsSL https://raw.githubusercontent.com/ryanwuson/rime-liur/main/rime_liur_installer.sh | bash
# but without the TTY prompts (which the installer forces via `read ... </dev/tty`),
# so it can run inside a non-interactive shell / CI.
#
# It replicates the upstream logic exactly:
#   1. fetch the repo file tree, classify (root / lua / lunar / opencc / configs / fonts)
#   2. download everything except docs / fonts/Windows Only / installers
#   3. pick schema version -> liur.schema.yaml  (VERSION=mixed|chinese-only)
#   4. install the three required fonts to ~/Library/Fonts
#   5. relaunch Squirrel to trigger deployment
#
# Prereq: Squirrel already installed (brew install --cask squirrel-app).
# See docs/squirrel-boshiamy-setup.md.
#
set -euo pipefail

VERSION="${VERSION:-mixed}"                 # mixed = full (with English vocab); chinese-only = pure Chinese
GITHUB_REPO="ryanwuson/rime-liur"
GITHUB_BRANCH="main"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}"
EXCLUDE_PATTERNS='^docs/|^README\.md$|^LICENSE$|^\.gitignore$|^rime_liur_installer\.sh$|^rime_liur_installer\.ps1$|^fonts/Windows Only/'

RIME_FOLDER="${RIME_FOLDER:-$HOME/Library/Rime}"
FONT_FOLDER="${FONT_FOLDER:-$HOME/Library/Fonts}"
SQUIRREL_APP="/Library/Input Methods/Squirrel.app"

if [ ! -d "$SQUIRREL_APP" ]; then
  echo "ERROR: Squirrel not installed at $SQUIRREL_APP" >&2
  echo "       Run: brew install --cask squirrel-app" >&2
  exit 1
fi
case "$VERSION" in
  mixed|chinese-only) ;;
  *) echo "ERROR: VERSION must be 'mixed' or 'chinese-only' (got '$VERSION')" >&2; exit 1 ;;
esac
command -v python3 >/dev/null || { echo "ERROR: python3 required" >&2; exit 1; }

echo "Fetching file tree from ${GITHUB_REPO}@${GITHUB_BRANCH} ..."
ALL_FILES=$(curl -fsSL "$GITHUB_API" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('tree', []):
    if item.get('type') == 'blob':
        print(item['path'])
")
[ -n "$ALL_FILES" ] || { echo "ERROR: GitHub API call failed" >&2; exit 1; }

ROOT=(); LUA=(); LUNAR=(); OPENCC=(); CONFIGS=(); FONTS=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  echo "$f" | grep -qE "$EXCLUDE_PATTERNS" && continue
  if   [[ "$f" == lua/lunar_calendar/* ]]; then LUNAR+=("$f")
  elif [[ "$f" == lua/* ]];               then LUA+=("$f")
  elif [[ "$f" == opencc/* ]];            then OPENCC+=("$f")
  elif [[ "$f" == configs/* ]];           then CONFIGS+=("$f")
  elif [[ "$f" == fonts/* ]];             then FONTS+=("$f")
  elif [[ "$f" != */* ]];                 then ROOT+=("$f")
  fi
done <<< "$ALL_FILES"

echo "Found: root=${#ROOT[@]} lua=${#LUA[@]} lunar=${#LUNAR[@]} opencc=${#OPENCC[@]} configs=${#CONFIGS[@]} fonts=${#FONTS[@]}"

mkdir -p "$RIME_FOLDER/lua/lunar_calendar" "$RIME_FOLDER/opencc" "$RIME_FOLDER/configs" "$FONT_FOLDER"

dl() { # <remote_path> <local_path>  — with retry + URL-encoding tolerance
  local remote="$1" local_path="$2" n
  mkdir -p "$(dirname "$local_path")"
  for n in 1 2 3; do
    if curl -fsSL "${GITHUB_RAW}/${remote}" -o "$local_path"; then return 0; fi
    echo "  retry ($n) ${remote}" >&2; sleep 1
  done
  echo "ERROR: failed to download ${remote}" >&2; return 1
}

echo "Downloading schema files..."
for f in "${ROOT[@]}";    do dl "$f" "$RIME_FOLDER/$(basename "$f")"; done
for f in "${LUA[@]}";     do dl "$f" "$RIME_FOLDER/lua/$(basename "$f")"; done
for f in "${LUNAR[@]}";   do dl "$f" "$RIME_FOLDER/lua/lunar_calendar/$(basename "$f")"; done
for f in "${OPENCC[@]}";  do dl "$f" "$RIME_FOLDER/opencc/$(basename "$f")"; done
for f in "${CONFIGS[@]}"; do dl "$f" "$RIME_FOLDER/configs/$(basename "$f")"; done

echo "Configuring schema version = ${VERSION} ..."
if [ "$VERSION" = "mixed" ]; then
  cp "$RIME_FOLDER/configs/liur.schema.yaml"           "$RIME_FOLDER/liur.schema.yaml"
else
  cp "$RIME_FOLDER/configs/liur.chinese-only.schema.yaml" "$RIME_FOLDER/liur.schema.yaml"
fi
rm -rf "$RIME_FOLDER/configs"

echo "Installing fonts to ${FONT_FOLDER} ..."
for f in "${FONTS[@]}"; do
  n="$(basename "$f")"
  if [ -f "$FONT_FOLDER/$n" ]; then echo "  skip $n (exists)"
  else dl "$f" "$FONT_FOLDER/$n"; echo "  got $n"; fi
done

echo "Deploying (relaunch Squirrel) ..."
killall Squirrel 2>/dev/null || true
sleep 1
open "$SQUIRREL_APP"

echo
echo "Done. Add Rime in: System Settings -> Keyboard -> Input Sources -> +"
echo "Then switch schema (Ctrl+\` or F4) and pick 'liur' (嘸蝦米)."
