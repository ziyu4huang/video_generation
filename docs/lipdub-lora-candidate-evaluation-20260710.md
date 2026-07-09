# LipDub precision candidates: elix3r AV-LoRA vs. ID-LoRA — evaluation, 2026-07-10

## Why this exists

`docs/lipsync-lse-metric-measurement-20260710.md` measured this repo's
current LipDub IC-LoRA at LSE-D 13.68 — a real, non-trivial improvement over
Python IA2V (16.81-16.94) but still far short of the ≤1.5 adequacy bar.
`output/next-goal-20260709-202200.md` filed two candidate checkpoints "if
LipDub with a better metric still underperforms IA2V" — that gate has now
fired. This doc evaluates both, per priority 1 of
`output/next-goal-20260710-051950.md`. **Research only — no integration work
done in this pass.**

## Candidate 1: `elix3r/LTX-2.3-22b-AV-LoRA-talking-head` — **rejected, wrong shape**

Community LoRA, first AV LoRA for LTX-2.3's joint audio-video cross-attention.
Usage: trigger word `OHWXPERSON`, prompt ends with the speech transcript text.
Critically, it **internalizes voice characteristics during training and does
not take external reference audio at inference** — it generates speech (in
the trained character's learned voice) from a text transcript, not from a
dubbed WAV file.

This is architecturally a **different product**: a per-character virtual
persona that always speaks in its own trained voice, not a general
audio-dubbing tool. It requires training data + a dedicated LoRA per
character (Dreambooth-style), which is a much heavier lift than a checkpoint
swap, and it doesn't address this repo's actual use case (`video lipdub
--lipdub-reference-video HEAD.mp4` — dub an *arbitrary* existing reference
video/audio onto a portrait). **Rejected as a candidate for the
lip-sync-to-external-audio gap.** Might be worth filing separately as a
"branded persona / consistent-narrator" capability if that ever becomes a
distinct goal, but that's not this gap.

## Candidate 2: `ID-LoRA` (ECCV 2026, `github.com/ID-LoRA/ID-LoRA`) — **strong candidate, right shape**

Official paper + code + weights (Aviad Dahan, Moran Yanuka, Noa Kraicer, Lior
Wolf, Raja Giryes — [arXiv 2603.10256](https://arxiv.org/pdf/2603.10256)).
Jointly generates a subject's appearance *and* voice from **a reference
image + a short reference audio clip + a text prompt in one pass** — same
use-case shape as this repo's existing LipDub/IA2V paths (external reference
audio drives the dub), not a per-character-trained persona like Candidate 1.
Zero-shot inference (no per-identity training required at use time — the
LoRA itself is pretrained once and generalizes).

**Reported numbers**: ID-LoRA "leads in lip synchronization (LSE-D/C) and
audio prompt adherence (CLAP)" on its own benchmark; the CelebV-HQ checkpoint
applied to the TalkVid benchmark scores **LSE-D 10.32**. That's measured on a
different benchmark/reference set than this repo's own 8s clip, so it isn't
directly comparable apples-to-apples to the 13.68 measured here — but it's
the same metric family, published by the model's own authors as a headline
result, and is meaningfully lower (better) than what we measured for the
existing LipDub IC-LoRA. Still above the 1.5 adequacy bar even on the
authors' own best-case benchmark, so this would not be a silver bullet, but
it is a credible, well-documented step down from 13.68.

**Availability**: LTX-2.3-recommended checkpoint (`ID-LoRA 2.3`, built for
the 22B model this repo already runs), ~1.1GB LoRA weights on Hugging Face
(`AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K` and similar), `LTX-2-community-
license` (same license family already governing other LTX assets in this
repo's model tree — no new license class to vet). Native ComfyUI support
merged upstream (signal of real-world adoption/maintenance, not a one-off
research drop). Repo ships `packages/ltx-core` — worth checking during
integration whether it's a compatible fork of the same `ltx-core-mlx`-adjacent
architecture this repo vendors, or a separate PyTorch/CUDA reference
implementation that would need porting (the vendored `ltx-2-mlx` stack here
is MLX-native; ID-LoRA's reference repo is unverified-MLX in this pass — that
compatibility check is the first concrete step of any integration attempt,
not assumed).

## Recommendation

**ID-LoRA is the credible next lead; elix3r AV-LoRA is out.** Before
committing engine time to a Swift LipDub port
(`docs/lipdub-swift-port-scoping-20260709.md`), the higher-leverage move is:

1. Check whether `ID-LoRA/ID-LoRA`'s `ID-LoRA-2.3/packages/ltx-core` is MLX
   or PyTorch/CUDA — determines whether this is a "download + wire into
   existing `ltx_pipeline.py` conditioning" job (cheap, if it's compatible
   with the vendored `ltx-2-mlx` conditioning primitives) or a "port a new
   reference architecture to MLX" job (expensive, same class of effort as
   the LipDub IC-LoRA integration already done).
2. If compatible: import the CelebV-HQ checkpoint via the existing
   `import-lora-image`-style tooling (adapted for AV LoRAs, per
   `[[project_model_import]]`), wire a `video generate --id-lora
   REFERENCE_IMAGE REFERENCE_AUDIO` (or extend `video lipdub`) path, and
   re-run the same SyncNet LSE-D/LSE-C measurement harness
   (`app/syncnet_bridge.py`, already built in #394) against the same 8s
   reference clip used for the IA2V/LipDub comparison — same metric, same
   reference, directly comparable this time (no cross-benchmark caveat).
3. Only escalate to the Swift LipDub/ID-LoRA port if the Python-side
   measurement clears (or meaningfully approaches) the 1.5 bar — otherwise
   this stays a Python-only research finding and the Swift port stays
   parked, per the existing gating discipline.

This is scoped but **not attempted in this pass** — it is real new-vendor
integration work (checkpoint import + possible new conditioning code +
possible MLX port), correctly sized as its own future session rather than
folded into this one alongside the ambient-sound verification and capability
matrix updates already done today.

## Sources

- [ID-LoRA GitHub](https://github.com/ID-LoRA/ID-LoRA)
- [ID-LoRA project page](https://id-lora.github.io/)
- [ID-LoRA arXiv paper (2603.10256)](https://arxiv.org/pdf/2603.10256)
- [AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K — Hugging Face](https://huggingface.co/AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K)
- [elix3r/LTX-2.3-22b-AV-LoRA-talking-head — Hugging Face](https://huggingface.co/elix3r/LTX-2.3-22b-AV-LoRA-talking-head)
- [Lightricks/LTX-2.3-22b-IC-LoRA-LipDub — Hugging Face](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-LipDub) (existing checkpoint this repo already uses)
