---
id: "auto-memory:argparse-sentinel-for-user-override"
created: 1970-01-01
tags: [zettel, pattern, auto-memory, feedback, argparse-lora-scale-override-bug, self-fix-dimension-aware-gate]
sources: ["auto-memory:pi-memory"]
source: "auto-memory:pi-memory"
source_id: "auto-memory:argparse-sentinel-for-user-override"
record_type: pattern
status: active
superseded_by: 
confidence: 1
dimension: feedback
---
# To detect whether the user overrode an argparse flag, use default=None sentinel + resolve in run code; NEVER magic-number-compare against a concrete default — it can't distinguish explicit-default from omitted

## 核心想法
When run code needs to know whether the user actually passed a CLI flag (vs left it at default) — to auto-set a mode-specific value only when omitted — the reliable pattern is **`default=None` sentinel + resolve in run code**:

```python
parser.add_argument("--cfg-scale", type=float, default=None, dest="cfg_scale", ...)
# run code:
if distilled:        args.cfg_scale = 1.0
elif begin_image and args.cfg_scale is None: args.cfg_scale = 3.0
elif args.cfg_scale is None:                 args.cfg_scale = 5.0   # standard default
```

**Never** compare against a concrete default value to detect "user didn't override":

```python
# WRONG — 5.0 is the argparse default:
if args.cfg_scale == 5.0:   args.cfg_scale = 3.0   # silently overrides an EXPLICIT --cfg-scale 5.0
```

When the magic number IS the default, the check fires both when the flag was omitted AND when the user explicitly passed that value — so an explicit user choice matching the default is silently overridden with no warning. Any *other* explicit value (e.g. 4.0) is kept, making the bug intermittent and hard to spot.

**Why:** the "did the user override this?" question is about flag *presence*, not value. A concrete default collapses those two cases into one indistinguishable value. `None` (a value the type converter can never produce for float/int/str flags) cleanly encodes "not supplied".

**How to apply:**
- For any flag whose default you conditionally auto-change per mode, set `default=None` even if the effective default is a concrete number. Resolve `None` → effective default in run code, after the mode-specific auto-sets.
- This is the same pattern `stage1_steps`/`stage2_steps` already use (default None, auto-set per mode) — follow it for consistency.
- Symmetric trap, opposite direction: a `None` default that flows UNresolved into downstream code poisons it (e.g. `steps=None` → `set_timesteps(None)` crash) — see argparse-lora-scale-override-bug for the None-must-be-resolved-before-use side. The rule covers both: **None sentinel to detect override, but ALWAYS resolve None to a concrete value before the value is consumed.**

**Recurring — bit three times (2026-06-14/15/22):**
1. Workflow `run-self-improve-image` fix-command builder: a fix omitting `steps` ran without `--steps` → run.py defaulted to 9 while the i2i baseline ran at 15 → silent steps confound. Fix: baselineSteps fallback (commit aed4be2). Upstream `steps=None` crash separately guarded by `or 9` (image-i2i.py:335).
2. `video-generate.py` FLF2V `if args.cfg_scale == 5.0:` silently overrode explicit `--cfg-scale 5.0` to 3.0. Fix: None sentinel (commit f44436a). Found by review-optimize low-effort run (conf 90).
3. `image-t2i --transformer` defaulted to "klein-9b" (the flux2-klein value) and RunConfig.from_args used `if pipeline=="zimage" and transformer=="klein-9b": transformer=None` to undo it for zimage — magic-value compare, can't distinguish omitted from explicit. Fix: default=None sentinel, `_shared.py` flux2 path `or "klein-9b"` fallback (commit c3956c6, feat/models-8bit); zimage default now resolves to cfg.TRANSFORMER_DIR [moody-pro-mix]. Lesson: a flag shared across pipelines needs a sentinel, never a default borrowed from one pipeline.

Related: argparse-lora-scale-override-bug (the None-flowing-through side), self-fix-dimension-aware-gate (steps confound muddied the gate attribution).

## 證據 / 脈絡
- type: pattern
- confidence: 1
- status: active
- provenance: auto-memory:pi-memory

## 連結
- 相關：[[auto-memory-faceswap-bfs-self-test-verified]]
- 相關：[[auto-memory-always-self-reflect-and-write-next-goal]]
- 相關：[[auto-memory-argparse-lora-scale-override-bug]]
- 相關：[[auto-memory-argv-injection-positional-paths]]
- 相關：[[auto-memory-audio-noise-detection-false-positive]]
- 相關：[[auto-memory-bash-batch-var-drops-runpy-flags]]
- 相關：[[auto-memory-bun-dev-server-background-sigterm]]
- 相關：[[auto-memory-concurrent-session-sweeps-working-tree]]
