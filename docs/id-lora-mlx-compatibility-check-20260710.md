# ID-LoRA MLX compatibility check — 2026-07-10

## Why this exists

`docs/lipdub-lora-candidate-evaluation-20260710.md` scoped ID-LoRA as the
credible next lead for the LipDub precision gap, with step 1 of its
integration plan being: "check whether `ID-LoRA/ID-LoRA`'s
`ID-LoRA-2.3/packages/ltx-core` is MLX or PyTorch/CUDA — determines whether
this is a cheap checkpoint-swap or an expensive architecture port." This doc
answers that question definitively.

## Finding: PyTorch/CUDA reference repo, but the LoRA checkpoint itself is a drop-in

`packages/ltx-core/pyproject.toml` (confirmed via `gh api`):
```
dependencies = ["torch~=2.7", "torchaudio", ..., "accelerate", "scipy>=1.14"]
[project.optional-dependencies]
xformers = ["xformers"]
```
This is a PyTorch/CUDA-only reference implementation (xformers has no MPS
path — see `[[project_attention_backends_mps]]`). Porting `ltx-core` itself
to MLX would be the expensive path the scoping doc warned about.

**But that's not actually necessary.** `ID-LoRA-2.3/README.md` states the
base model is `ltx-2.3-22b-dev.safetensors` (Lightricks/LTX-Video) — the
exact same base checkpoint this repo already runs natively in MLX
(`mlx-models/ltx-mlx/dev/`) — and that "training uses the same
`audio_ref_only_ic` strategy as the base model," i.e. the SAME IC-LoRA
conditioning family (reference image + reference audio) as this repo's
already-working `ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`. `ltx-core` is
only the training/reference-inference harness; the actual deliverable —
the LoRA checkpoint — is architecture-agnostic (it's just weight deltas
keyed by module name).

**Confirmed by direct safetensors header inspection** (HTTP range request
for the header only, no full 1.1GB download):

`AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K/lora_weights.safetensors` — 1728
tensors:
```
diffusion_model.transformer_blocks.0.audio_attn1.to_k.lora_A.weight [128, 2048] BF16
diffusion_model.transformer_blocks.0.audio_attn1.to_k.lora_B.weight [2048, 128] BF16
diffusion_model.transformer_blocks.0.audio_attn2...  (same pattern)
diffusion_model.transformer_blocks.0.audio_ff.net.0.proj.lora_A.weight [128, 8192] BF16
```

This repo's own `mlx-models/lora/ltx-2-3-lipdub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`
(already loaded and fused successfully in production, per
`[[project_lipdub_gated_blocker]]`) — **byte-identical key naming and
shapes**, same 1728 audio-related tensors out of 2688 total:
```
diffusion_model.transformer_blocks.0.audio_attn1.to_k.lora_A.weight [128, 2048] BF16
diffusion_model.transformer_blocks.0.audio_attn1.to_k.lora_B.weight [2048, 128] BF16
diffusion_model.transformer_blocks.0.attn1.to_k.lora_A.weight [128, 4096] BF16   ← video branch
```

No `.default.` PEFT-multi-adapter infix on either (contrast with the vbvr
LoRAs, which DO have `.default.` — a different LoRA export convention, not
relevant here since vbvr isn't the comparison point). Rank 128 on both,
same audio-branch dim (2048) vs video-branch dim (4096) split on both. This
is the same LoRA export pipeline, same target module set, same base model.

## Conclusion: this is a checkpoint swap, not a port

The MLX transformer already has `audio_attn1`/`audio_attn2`/`audio_ff`
LoRA-fusable modules wired up (proven by LipDub already working end-to-end
in production). ID-LoRA's checkpoint targets the identical module set with
the identical shapes. **No new MLX code is needed** — this reduces to the
same class of change as swapping between vbvr LoRA variants:

1. Download `id-lora-celebvhq-ltx2.3/lora_weights.safetensors` (or the
   TalkVid variant) into `mlx-models/lora/id-lora-celebvhq-ltx2.3/` (not
   gated — confirmed via HF API, `"gated": false` — no HF token/access
   request needed, unlike the LipDub checkpoint itself).
2. Run `run.py video lipdub --lipdub-lora mlx-models/lora/id-lora-celebvhq-ltx2.3/lora_weights.safetensors ...`
   — `video-lipdub.py` already supports an explicit `--lipdub-lora` path
   override (same auto-detect-or-explicit pattern as vbvr), so this needs
   zero new CLI plumbing either.
3. Re-run the existing SyncNet LSE-D/LSE-C harness (`app/syncnet_bridge.py`)
   against the same 8s reference clip used in the #394/LipDub measurement
   for an apples-to-apples number against the current 13.68.

This was step 1 of the integration plan in
`docs/lipdub-lora-candidate-evaluation-20260710.md`; steps 2-3 (download +
measure) are now unblocked and are the concrete next step — not attempted
in this pass (this was research-only, confirming compatibility before
spending the download + a real generation run).

## Sources

- `gh api repos/ID-LoRA/ID-LoRA/contents/packages/ltx-core/pyproject.toml`
- `gh api repos/ID-LoRA/ID-LoRA/contents/ID-LoRA-2.3/README.md`
- `curl -r <range> https://huggingface.co/AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K/resolve/main/lora_weights.safetensors` (safetensors header only)
- `mlx-models/lora/ltx-2-3-lipdub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors` (local, header inspected the same way)
- `curl https://huggingface.co/api/models/AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K` (gated=false)
