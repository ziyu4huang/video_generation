# krea2-depth-control-lora

Krea 2 **depth Control LoRA** (`Patil/Krea-2-depth-controlnet`, 862 MB, bf16).
**Not** a standalone ControlNet — a rank-64 LoRA + an expanded input projection.

- **224 LoRA pairs**: `blocks.0..27` × `{attn.wq,wk,wv,wo,gate, mlp.gate,up,down}`,
  rank 64, α = rank → scale 1.0. Applied in `Krea2DiT.lin()` (keeps the base Q8
  turbo weights untouched).
- **Expanded `first.weight` (6144, 128)**: `[:, :64]` = the base model's own
  input projection; `[:, 64:128]` = the **control half** that projects the
  control latent at the DiT input (`x = first_base(img) + firstControl(ctrl)`).
- Real checkpoint key convention: `blocks.{i}.{target}.{A,B}` (no `.weight`
  suffix); `A=(rank,in)`, `B=(out,rank)`.

Consumed by the **pure-Swift** `swift/krea2-image-director` `controlnet`
subcommand. `Krea2ControlLoRA.swift` tolerates 6 key conventions + both A/B axis
orders. Real-silicon validated 2026-07-04 (loader: 224/224 pairs + control half;
control signal monotonic; control-image identity matters). Depth-Anything-V2
preprocessor is a separate arc — caller supplies a depth PNG today.

See `swift/krea2-image-director/docs/controlnet-styletransfer-validation.md`.
