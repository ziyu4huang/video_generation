# LTX-2.3 22B Distilled Transformer (v1.1, Q8)

Knowledge-distilled version of LTX-2.3 22B for fast video generation.

- **Steps**: 8 (stage 1) + 3 (stage 2) — predefined sigma schedules
- **CFG**: 1.0 (no classifier-free guidance needed)
- **Quality**: Slightly lower than dev model, but 3-4× faster
- **Size**: ~19 GB (MLX INT8 quantized)

## Source

Downloaded from [dgrauet/ltx-2.3-mlx-q8](https://huggingface.co/dgrauet/ltx-2.3-mlx-q8).
Original weights by Lightricks, MLX conversion by dgrauet.

## Usage

```bash
python run.py video --distilled --prompt "a sunset over the ocean" \
    --width 704 --height 480 --frames 97
```

## Compatible Components

- Text encoder: `text_encoder/ltx-2.3-connector`
- VAE: `vae/ltx-2.3-vae`
- Audio: `audio/ltx-2.3-audio`

Note: The distilled model does NOT use the distilled LoRA — it's a standalone
transformer. Do NOT use for LoRA training.
