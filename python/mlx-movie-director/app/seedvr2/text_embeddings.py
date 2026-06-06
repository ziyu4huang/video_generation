"""Load pre-computed SeedVR2 text embeddings (pos_emb.pt / neg_emb.pt)."""

import os

import mlx.core as mx
import torch

from app import config as cfg


class SeedVR2TextEmbeddings:
    POS_EMB_SHAPE = (58, 5120)

    @staticmethod
    def load_positive(batch_size: int = 1) -> mx.array:
        """Load positive text embedding from pos_emb.pt."""
        path = cfg.SEEDVR2_POS_EMB
        if not os.path.exists(path):
            raise FileNotFoundError(f"Text embedding not found: {path}")
        pt_tensor = torch.load(path, map_location="cpu", weights_only=True)
        emb = mx.array(pt_tensor.float().numpy()).astype(mx.bfloat16)
        if emb.ndim == 2:
            emb = emb[None, ...]
        if batch_size > 1:
            emb = mx.repeat(emb, batch_size, axis=0)
        return emb

    @staticmethod
    def load_negative(batch_size: int = 1) -> mx.array:
        """Load negative text embedding from neg_emb.pt."""
        path = cfg.SEEDVR2_NEG_EMB
        if not os.path.exists(path):
            raise FileNotFoundError(f"Text embedding not found: {path}")
        pt_tensor = torch.load(path, map_location="cpu", weights_only=True)
        emb = mx.array(pt_tensor.float().numpy()).astype(mx.bfloat16)
        if emb.ndim == 2:
            emb = emb[None, ...]
        if batch_size > 1:
            emb = mx.repeat(emb, batch_size, axis=0)
        return emb
