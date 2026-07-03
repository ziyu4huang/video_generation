# qwen3-4b-instruct

Qwen3-VL-4B-Instruct **LM-half** text encoder for Krea 2 — 4-bit MLX (group_size=32).

Extracted from the full `Qwen/Qwen3-VL-4B-Instruct` model (`language_model.*` →
`model.*`) and quantized by
`python/mlx-movie-director/scripts/krea2_extract_instruct_encoder.py`.

Krea 2 taps hidden states at 12 layers `(2,5,8,11,14,17,20,23,26,29,32,35)`,
chat-template-wrapped with the first 34 template tokens stripped, max_len 512.

⚠️ Must be the **Instruct** variant, not the base `qwen3-4b` — the base produced
2/10 glitchy output; Instruct fixed it to 8.5/10.
