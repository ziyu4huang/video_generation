#!/usr/bin/env bash
# Rigorous compile ON vs OFF benchmark — interleaved to spread thermal load.
# Thermal noise is ±20-30% between consecutive runs; only interleaving + averaging
# across N iterations isolates the real compile effect.
set -e
cd /Users/huangziyu/proj/video_generation
OUT=/Users/huangziyu/proj/video_generation__output/compile_interleaved
mkdir -p "$OUT"
PROMPT="photorealistic close-up portrait of a young East Asian woman, natural light makeup, visible skin pores, soft natural lighting, 85mm lens"
N=4  # 4 each = 8 runs, interleaved

echo "Interleaved A/B: $N iterations each, alternating ON/OFF to spread thermal load"
echo "────────────────────────────────────────────────────────────────"
printf "%-4s %-8s %-10s %-12s %-10s\n" "run" "mode" "total_s" "peak_mem_MB" "avg_it_s"
echo "────────────────────────────────────────────────────────────────"

for i in $(seq 1 $N); do
  for mode in compile nocompile; do
    flag=""
    [ "$mode" = "compile" ] && flag="--compile"
    swift run --package-path swift/z-image-director zimage t2i \
      --transformer moody-pro-mix --prompt "$PROMPT" \
      --seed 777 --width 832 --height 1216 \
      --output-dir "$OUT" --name "${mode}_${i}" $flag >/dev/null 2>&1
    # Extract from manifest
    python/venv/bin/python - "$OUT/${mode}_${i}.manifest.json" "$mode" "$i" << 'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
mode, i = sys.argv[2], sys.argv[3]
p = d['perf']
print(f"{i:<4} {mode:<8} {p['total_seconds']:<10.2f} {p['peak_memory_mb']:<12.0f} {p['avg_it_per_sec']:<10.3f}")
PYEOF
  done
done
echo "────────────────────────────────────────────────────────────────"
echo ""
echo "=== AGGREGATE (mean ± range over $N runs each) ==="
python/venv/bin/python - "$OUT" "$N" << 'PYEOF'
import json, sys, statistics
out, n = sys.argv[1], int(sys.argv[2])
def stats(mode):
    ts, ms, its = [], [], []
    for i in range(1, n+1):
        d = json.load(open(f"{out}/{mode}_{i}.manifest.json"))
        p = d['perf']
        ts.append(p['total_seconds']); ms.append(p['peak_memory_mb']); its.append(p['avg_it_per_sec'])
    return ts, ms, its
for mode in ['compile','nocompile']:
    ts, ms, its = stats(mode)
    print(f"{mode:10}: total={statistics.mean(ts):.2f}s (range {min(ts):.2f}-{max(ts):.2f}, σ={statistics.stdev(ts):.2f})  "
          f"mem={statistics.mean(ms):.0f}MB (σ={statistics.stdev(ms):.0f})  "
          f"avg_it/s={statistics.mean(its):.3f}")
PYEOF
