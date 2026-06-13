# LTX Tuning Log

Running, objective-agnostic record of **confirmed** LTX generation-tuning
findings. Appended by the `mlx-movie-director-ltx-self-improve` workflow's
Knowledge phase — only levers that improved the composite score by ≥ the margin
(and were reproduced) are written here. Within-noise / rejected moves stay in
the per-run history under `.claude/workflows/history/mlx-movie-director-ltx-self-improve/`,
not in this log.

## Entry format

```
### YYYY-MM-DD · <objective> · <lever>  (Δcomposite +N, voice X→Y, quality X→Y)
- Base: transformer / stage1 / frames / cfg / seed
- Change: --<knob> <from> → <to>
- Evidence: <how confirmed — iteration/seed/run ids>
- Verdict: ADOPTED | CONFIRMED-CEILING | REJECTED
```

## Confirmed findings

### 2026-06-13 · voice · audio-knob sweep  (marginal; cluster 67–75)
- Base: dasiwa / 16 stage1 / 57f / cfg5 / seed42 / optimized close-up prompt
- Sweep: `--audio-cfg-scale` {default,3,5} × `--audio-stage1-only` {off,on}
- Evidence: 6-cell sweep, all ASR 100% / WER 0; composite voice_score clustered 67–75
- Verdict: CONFIRMED-CEILING
  - `--audio-stage1-only` gives a slight, consistent edge (top-2 cells use it).
  - `--audio-cfg-scale 3.0` is consistently worst (both 3.0 cells bottom).
  - No config breaks the ~60% naturalness ceiling — these knobs affect tone, not
    word-intelligibility. Don't re-sweep them; the next real lever is the
    `av_ca` speech-gate multiplier (`vendor_patches.py`, currently fixed at 1000.0).
- Full case study: `docs/ltx-voice.md`. Scoring: `scripts/measure_ltx.py`,
  `app/voice_metrics.voice_score`, `app/quality_metrics.composite_quality_score`.
