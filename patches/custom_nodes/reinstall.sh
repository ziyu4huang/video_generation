#!/bin/bash
# Reinstall missing custom nodes for this ComfyUI setup.
# Usage:
#   bash scripts/reinstall_custom_nodes.sh              # interactive, verbose
#   bash scripts/reinstall_custom_nodes.sh --quiet       # only print when action needed
#
# Called automatically by run.sh before ComfyUI starts.
# NOGIT nodes (Manager-installed) are printed as reminders but not auto-installed.

set -e

# ── Config ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
NODES_DIR="$REPO_DIR/comfyui_data/custom_nodes"
PATCHES_DIR="$REPO_DIR/patches/custom_nodes"
QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

log() { $QUIET || echo "$@"; }

# Format: "directory  commit_hash  repo_url"
NODES=(
  "ComfyUI_Comfyroll_CustomNodes  d78b780ae43fcf8c6b7c6505e6ffb4584281ceca  https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes"
  "ComfyUI_essentials             9d9f4bedfc9f0321c19faf71855e228c93bd0dc9  https://github.com/cubiq/ComfyUI_essentials.git"
  "ComfyUI_LayerStyle             d94bef1ee5ed3656f5ff1bb2830a4ffd94f40935  https://github.com/chflame163/ComfyUI_LayerStyle"
  "comfyui_memory_cleanup         58de13a6090e04408e343501ff8902c034d9f518  https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup.git"
  "ComfyUI_RH_LLM_API             26e18d1a769bd08e115b59bfdf170f8a2166c0df  https://github.com/HM-RunningHub/ComfyUI_RH_LLM_API"
  "ComfyUI_UltimateSDUpscale      bebd5696fddd61cb0d08949a222c508898ab5577  https://github.com/ssitu/ComfyUI_UltimateSDUpscale.git"
  "ComfyUI-AutoCropFaces          b2139db9a8ffb4707832106a58f519bbd04e6118  https://github.com/liusida/ComfyUI-AutoCropFaces.git"
  "ComfyUI-Custom-Scripts         609f3afaa74b2f88ef9ce8d939626065e3247469  https://github.com/pythongosssss/ComfyUI-Custom-Scripts"
  "ComfyUI-dapaoAPI               642820a97ab8fa92b8c065d8bab7ae8bd6220868  https://github.com/paolaoshi/ComfyUI-dapaoAPI.git"
  "ComfyUI-GGUF                   6ea2651e7df66d7585f6ffee804b20e92fb38b8a  https://github.com/city96/ComfyUI-GGUF.git"
  "ComfyUI-Impact-Pack            429d0159ad429e64d2b3916e6e7be9c22d025c3c  https://github.com/ltdrdata/ComfyUI-Impact-Pack.git"
  "ComfyUI-Impact-Subpack         50c7b71a6a224734cc9b21963c6d1926816a97f1  https://github.com/ltdrdata/ComfyUI-Impact-Subpack.git"
  "Comfyui-PainterFluxImageEdit   8b25957c6ba31a697ad5608f93f035d4d93cc5ab  https://github.com/princepainter/Comfyui-PainterFluxImageEdit.git"
  "ComfyUI-qwenmultiangle         6f93d9b15a50c07c13411734723fe5cae287e7aa  https://github.com/jtydhr88/ComfyUI-qwenmultiangle.git"
  "ComfyUI-ReservedVRAM           1e5757db878ef05ac4ac8f169ddfdbeb4b53dfaa  https://github.com/Windecay/ComfyUI-ReservedVRAM.git"
  "ComfyUI-SeedVR2_VideoUpscaler  4490bd1f482e026674543386bb2a4d176da245b9  https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git"
  "ComfyUI-VideoHelperSuite       4ee72c065db22c9d96c2427954dc69e7b908444b  https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite"
  "Dapao-Toolbox                  19736400ad527f5e5e47de2279693cc3ea907232  https://github.com/paolaoshi/Dapao-Toolbox"
  "fp8-mps-metal                  8db4dd2134c8e17e869e983f3c7e6ab1bf031fc8  https://github.com/tashiscool/fp8-mps-metal.git"
  "rgthree-comfy                  738105af5fb14e96fbecaf406dc356e284797e8c  https://github.com/rgthree/rgthree-comfy"
)

# NOGIT nodes — installed by ComfyUI-Manager, not auto-restorable
NOGIT_NODES=(
  "ComfyUI-Manager    https://github.com/ltdrdata/ComfyUI-Manager"
  "ComfyUI-Easy-Use   https://github.com/yolain/ComfyUI-Easy-Use"
  "ComfyUI-KJNodes    https://github.com/kijai/ComfyUI-KJNodes"
  "cg-use-everywhere  https://github.com/chrisgoringe/cg-use-everywhere"
  "ComfyUI-RMBG       https://github.com/Jcd1230/ComfyUI-RMBG"
  "Comfyui-Resolution-Master  (install via Manager search)"
)

mkdir -p "$NODES_DIR"

# ── Detect & clone missing nodes ──
missing=0
cloned=0

for entry in "${NODES[@]}"; do
  read -r dir commit url <<< "$entry"
  target="$NODES_DIR/$dir"
  if [ -d "$target" ]; then
    continue  # already present, skip silently
  fi
  missing=$((missing + 1))
  echo "[custom-nodes] CLONE $dir @ ${commit:0:8}"
  git clone --quiet "$url" "$target"
  (cd "$target" && git checkout --quiet "$commit")
  cloned=$((cloned + 1))
done

if [ "$cloned" -gt 0 ]; then
  echo "[custom-nodes] Restored $cloned node(s)."
fi

# ── Apply patches for our modified nodes ──
for patch in "$PATCHES_DIR"/*.patch; do
  [ -f "$patch" ] || continue
  # Derive node dir from patch filename: fp8-mps-metal-init.patch → fp8-mps-metal
  patch_name=$(basename "$patch" .patch)
  # Strip trailing suffix after last dash (e.g. -init, -fix)
  node_dir=$(echo "$patch_name" | sed 's/-[a-z]*$//')
  target="$NODES_DIR/$node_dir"
  if [ -d "$target" ]; then
    # Check if patch is already applied
    if (cd "$target" && patch --dry-run --reverse --quiet -p1) < "$patch" 2>/dev/null; then
      : # already applied, skip
    else
      echo "[custom-nodes] Applying patch: $(basename "$patch")"
      (cd "$target" && patch -p1 --quiet) < "$patch"
    fi
  fi
done

# ── Report missing NOGIT nodes (informational only) ──
if [ "$missing" -eq 0 ]; then
  log "[custom-nodes] All git-based nodes present."
else
  log ""
fi

# Check NOGIT nodes
nogit_missing=()
for entry in "${NOGIT_NODES[@]}"; do
  read -r dir url <<< "$entry"
  [ -d "$NODES_DIR/$dir" ] || nogit_missing+=("$dir")
done

if [ "${#nogit_missing[@]}" -gt 0 ]; then
  echo "[custom-nodes] Missing Manager-installed nodes (install via ComfyUI-Manager UI):"
  for name in "${nogit_missing[@]}"; do
    echo "  - $name"
  done
fi
