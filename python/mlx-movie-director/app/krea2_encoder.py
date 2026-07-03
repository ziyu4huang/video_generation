"""Krea 2 text conditioner — Qwen3-VL-4B text-path encoder, 12-layer tapping.

MLX port of krea-ai/krea-2/encoder.py. Reuses the repo's existing Qwen3Model
(``app/text_encoder.py``) and the ``mlx-models/text_encoder/qwen3-4b`` weights
(36 layers, hidden_size 2560 == Krea ``txtdim``), adding:
  - the Qwen chat-template wrap (fixed prefix/suffix strings),
  - multi-layer hidden-state tapping at the 12 indices Krea's DiT expects,
  - the 34-token prefix strip.

The reference loads ``Qwen3-VL-4B-Instruct`` and uses only its LM/text path
(no vision patches). This implementation uses the base ``qwen3-4b`` weights
available in-repo; if output quality is degraded, swap to the Instruct LM
weights extracted from ``krea/Krea-2-Turbo`` ``text_encoder/model.safetensors``
(see Phase 1c parity check).
"""

import json
import os
from typing import Sequence

import mlx.core as mx
import mlx.nn as nn
from transformers import AutoTokenizer

from app import config as cfg
from app.text_encoder import Qwen3Model


# Krea's fixed prompt template (encoder.py).
_PREFIX = (
    "<|im_start|>system\nDescribe the image by detailing the color, shape, "
    "size, texture, quantity, text, spatial relationships of the objects and "
    "background:<|im_end|>\n<|im_start|>user\n"
)
_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n"
_PREFIX_IDX = 34        # prompt_template_encode_start_idx — prefix tokenizes to exactly 34
_SUFFIX_IDX = 5         # prompt_template_encode_suffix_start_idx — suffix tokenizes to 5
SELECT_LAYERS = (2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35)
MAX_LENGTH = 512


class Krea2TextEncoder(nn.Module):
    """Loads qwen3-4b (pre-quantized 4-bit gs32) and produces the (B, L, 12, 2560)
    stacked hidden-state tensor + key-padding mask that Krea2DiT.txtfusion expects."""

    def __init__(self, text_encoder_dir: str | None = None, tokenizer_dir: str | None = None):
        super().__init__()
        te_dir = text_encoder_dir or cfg.KREA2_TEXT_ENCODER_DIR
        tok_dir = tokenizer_dir or cfg.KREA2_TOKENIZER_DIR

        with open(os.path.join(te_dir, "config.json")) as f:
            te_config = json.load(f)
        self.model = Qwen3Model(te_config)
        # Match ZImage's load path: quantize the WRAPPER (so QuantizedLinear keys
        # land under `model.layers.*`), then load the pre-quantized weights.
        weights_path = os.path.join(te_dir, "model.safetensors")
        if os.path.exists(weights_path):
            nn.quantize(self, bits=4, group_size=32)
            self.load_weights(weights_path)
        else:
            raise FileNotFoundError(f"qwen3-4b weights not found at {weights_path}")
        mx.eval(self.parameters())

        self.tokenizer = AutoTokenizer.from_pretrained(tok_dir, trust_remote_code=True)

    def encode(self, prompts: Sequence[str]) -> tuple[mx.array, mx.array]:
        """prompts: list[str] (batch). Returns (hiddens (B, L, 12, 2560), mask (B, L) bool)."""
        # Tokenize prefix+prompt, padded to (max_length + prefix_idx - suffix_idx) = 541.
        padded_len = MAX_LENGTH + _PREFIX_IDX - _SUFFIX_IDX
        texts = [_PREFIX + p for p in prompts]
        inputs = self.tokenizer(
            texts, truncation=True, return_length=False,
            return_overflowing_tokens=False, padding="max_length", max_length=padded_len,
            return_tensors="np", add_special_tokens=False,
        )
        # Suffix tokens (fixed 5), tokenized separately and concatenated.
        suffix = self.tokenizer([_SUFFIX] * len(prompts), return_tensors="np", add_special_tokens=False)
        import numpy as np
        input_ids = mx.array(np.concatenate([inputs["input_ids"], suffix["input_ids"]], axis=1))
        mask_np = np.concatenate([inputs["attention_mask"], suffix["attention_mask"]], axis=1).astype(bool)
        mask = mx.array(mask_np)

        hs = self.model.forward_hidden_states(input_ids)  # list of (B, L_full, 2560)
        stacked = mx.stack([hs[i] for i in SELECT_LAYERS], axis=2)  # (B, L_full, 12, 2560)
        # Strip the 34-token prefix.
        hiddens = stacked[:, _PREFIX_IDX:]
        mask = mask[:, _PREFIX_IDX:]
        return hiddens, mask
