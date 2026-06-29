#!/usr/bin/env bash
# Wave-2 LoRA download + int8 convert. Run from repo root.
set -u
REPO=/Users/huangziyu/proj/video_generation
PY=$REPO/python/venv/bin/python
RUN=$REPO/python/mlx-movie-director/run.py
CONV=$REPO/python/mlx-movie-director/scripts/convert_lora_mlx.py
TOKEN="4f5a3e24629c4b7caa59d5a21d6c861e"
LOG=$REPO/scripts/dl-wave2-loras.log
: > "$LOG"

dl () {  # name "url"
  local name="$1" url="$2"
  echo ">>> IMPORT $name" | tee -a "$LOG"
  $PY "$RUN" import-lora "$url" --arch flux2-klein-9b --name "$name" --no-ai >>"$LOG" 2>&1
  echo ">>> CONVERT $name" | tee -a "$LOG"
  $PY "$CONV" --name "$name" >>"$LOG" 2>&1
  echo ">>> DONE $name" | tee -a "$LOG"
}

dl colorful  "https://civitai.com/models/2425555?modelVersionId=2779689&token=$TOKEN"
dl nexblend-asian "https://civitai.com/models/2535707?modelVersionId=2849806&token=$TOKEN"
dl darkklein-v2bfs-r256 "https://civitai.com/models/964312?modelVersionId=2742432&token=$TOKEN"
dl longface-9b "https://huggingface.co/NO8D/FaceControl/resolve/main/LongFace_9B.safetensors"
# qualitya already imported, just convert
echo ">>> CONVERT qualitya" | tee -a "$LOG"
$PY "$CONV" --name qualitya >>"$LOG" 2>&1
echo ">>> ALL DONE" | tee -a "$LOG"
