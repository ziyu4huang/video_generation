"""Extract the Qwen3-VL-4B-Instruct LM half from Krea-2-Turbo text_encoder and
save as a quantized (4-bit gs32) qwen3-4b-instruct weight set loadable by the
existing Qwen3Model. Strips `language_model.` -> `model.` prefix; drops visual.*.

Run after the text_encoder/model.safetensors download completes:
  python .../krea2_extract_instruct_encoder.py
"""
import os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
sys.path.insert(0, PKG)
import mlx.core as mx
import mlx.nn as nn
import numpy as np
import json

STAGE = "/Users/huangziyu/proj/video_generation__models/_staging_krea2"
SRC = os.path.join(STAGE, "text_encoder", "model.safetensors")
OUT_DIR = os.path.join(STAGE, "qwen3-4b-instruct")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"loading {SRC} ...", flush=True)
    raw = mx.load(SRC)
    # keep language_model.* only, remap language_model.X -> model.X
    remapped = {}
    for k, v in raw.items():
        if k.startswith("language_model."):
            remapped["model." + k[len("language_model."):]] = v
    print(f"kept {len(remapped)} LM tensors (dropped {len(raw)-len(remapped)} visual/etc)", flush=True)

    # Build TextEncoderMLX, quantize 4-bit gs32, load, save quantized weights.
    from app.text_encoder import TextEncoderMLX
    te_config = {"hidden_size": 2560, "intermediate_size": 9728, "num_attention_heads": 32,
                 "num_hidden_layers": 36, "num_key_value_heads": 8, "rms_norm_eps": 1e-6,
                 "rope_theta": 1000000.0, "vocab_size": 151936, "head_dim": 128}
    te = TextEncoderMLX(te_config)
    # TextEncoderMLX expects keys model.layers.* (its self.model = Qwen3Model)
    te.load_weights(list(remapped.items()))
    print("loaded LM weights into TextEncoderMLX; quantizing 4-bit gs32...", flush=True)
    nn.quantize(te, bits=4, group_size=32)
    mx.eval(te.parameters())
    # save
    out_path = os.path.join(OUT_DIR, "model.safetensors")
    te.save_weights(out_path)
    with open(os.path.join(OUT_DIR, "config.json"), "w") as f:
        json.dump(te_config, f, indent=2)
    print(f"saved -> {out_path}")


if __name__ == "__main__":
    main()
