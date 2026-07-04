"""Dump a REAL whisper-large-v3-mlx encoder-block-0 reference.

Unlike dump_whisper_encoder_reference.py (small random weights, architecture-
only check), this loads the ACTUAL production large-v3 checkpoint's real
conv1/conv2/block-0/ln_post weights (already cached locally at
~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx — the
SAME checkpoint python/mlx-movie-director's `_run_audio_asr_gate` transcribes
with) and runs a real partial forward (conv stem + positional embedding +
ONE real transformer block) on REAL log-mel features extracted from an
actual generated clip's speech audio. Mirrors this repo's own
"one real block, real checkpoint" precedent
(LTXModelRealCheckpointTests.testOneRealBlockProducesFiniteOutput) rather
than running the full 32-layer/1280-dim encoder, which is unnecessary to
prove WhisperEncoder.swift's math is bit-correct against production weights.

Does NOT commit the 3GB weights.npz anywhere — only the small (block-0-sized)
slice needed for this fixture is dumped.

Run from repo root (requires a real t2i2v output clip with speech — path
below defaults to one already present in this environment; override via
argv[1] if needed):
    python/venv/bin/python swift/ltx-video-director/scripts/dump_whisper_real_encoder_block_reference.py [video.mp4]
"""
import json
import os
import sys

import mlx.core as mx
import numpy as np
from safetensors.numpy import save_file

from mlx_whisper.audio import load_audio, log_mel_spectrogram, pad_or_trim, N_SAMPLES
from mlx_whisper.whisper import sinusoids

DEFAULT_VIDEO = "/Users/huangziyu/proj/video_generation__output/t2i2v_20260702_072817/output_20260702_072848.mp4"
CHECKPOINT = os.path.expanduser(
    "~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx/"
    "snapshots/49e6aa286ad60c14352c404340ded53710378a11/weights.npz"
)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test_refs", "whisper_real_encoder_block")


def gelu(x):
    return x * (1 + mx.erf(x / mx.sqrt(mx.array(2.0)))) / 2


def layer_norm(x, weight, bias, eps=1e-5):
    mean = x.mean(axis=-1, keepdims=True)
    var = ((x - mean) ** 2).mean(axis=-1, keepdims=True)
    return (x - mean) / mx.sqrt(var + eps) * weight + bias


def attention(x, w, prefix, n_head=20):
    b, n, d = x.shape
    head_dim = d // n_head
    scale = head_dim ** -0.25

    def linear(inp, wk, bk=None):
        out = inp @ w[wk].T
        if bk is not None:
            out = out + w[bk]
        return out

    q = linear(x, f"{prefix}.query.weight", f"{prefix}.query.bias")
    k = linear(x, f"{prefix}.key.weight")
    v = linear(x, f"{prefix}.value.weight", f"{prefix}.value.bias")

    q = (q.reshape(b, n, n_head, head_dim).transpose(0, 2, 1, 3)) * scale
    k = (k.reshape(b, n, n_head, head_dim).transpose(0, 2, 3, 1)) * scale
    v = v.reshape(b, n, n_head, head_dim).transpose(0, 2, 1, 3)

    qk = q @ k
    attn_w = mx.softmax(qk, axis=-1, precise=True)
    out = (attn_w @ v).transpose(0, 2, 1, 3).reshape(b, n, d)
    return linear(out, f"{prefix}.out.weight", f"{prefix}.out.bias")


if __name__ == "__main__":
    video = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VIDEO
    os.makedirs(OUT_DIR, exist_ok=True)

    audio = load_audio(video)
    audio = pad_or_trim(audio, N_SAMPLES)  # match mlx_whisper's real transcribe() padding
    # Trim to a short prefix after mel extraction to keep the dumped tensors
    # small — the block-0 math doesn't care about total sequence length.
    mel_full = log_mel_spectrogram(audio, n_mels=128)  # (n_frames, 128)
    mel = mel_full[:80]  # 80 mel-frames -> conv2 stride-2 halves to 40 audio tokens

    weights = mx.load(CHECKPOINT)

    mel_b = mel[None, :, :].astype(mx.float32)
    conv1_w = weights["encoder.conv1.weight"].astype(mx.float32)
    conv1_b = weights["encoder.conv1.bias"].astype(mx.float32)
    conv2_w = weights["encoder.conv2.weight"].astype(mx.float32)
    conv2_b = weights["encoder.conv2.bias"].astype(mx.float32)

    x = gelu(mx.conv1d(mel_b, conv1_w, stride=1, padding=1) + conv1_b)
    x = gelu(mx.conv1d(x, conv2_w, stride=2, padding=1) + conv2_b)
    pos = sinusoids(x.shape[1], x.shape[2]).astype(mx.float32)
    x = x + pos

    w32 = {k: v.astype(mx.float32) for k, v in weights.items() if k.startswith("encoder.blocks.0.")}
    w32_rel = {k[len("encoder.blocks.0."):]: v for k, v in w32.items()}

    residual = x
    attn_ln = layer_norm(x, w32_rel["attn_ln.weight"], w32_rel["attn_ln.bias"])
    attn_out = attention(attn_ln, w32_rel, "attn")
    x = residual + attn_out
    mlp_ln = layer_norm(x, w32_rel["mlp_ln.weight"], w32_rel["mlp_ln.bias"])
    mlp_hidden = gelu(mlp_ln @ w32_rel["mlp1.weight"].T + w32_rel["mlp1.bias"])
    mlp_out = mlp_hidden @ w32_rel["mlp2.weight"].T + w32_rel["mlp2.bias"]
    block0_output = x + mlp_out
    mx.eval(block0_output)

    outputs = {
        "mel_input": np.array(mel_b, copy=False),
        "conv1.weight": np.array(conv1_w, copy=False), "conv1.bias": np.array(conv1_b, copy=False),
        "conv2.weight": np.array(conv2_w, copy=False), "conv2.bias": np.array(conv2_b, copy=False),
        "block0_output": np.array(block0_output, copy=False),
    }
    for k, v in w32_rel.items():
        outputs[f"blocks.0.{k}"] = np.array(v, copy=False)

    save_file(outputs, os.path.join(OUT_DIR, "whisper_real_encoder_block.safetensors"))
    meta = {
        "video": video, "checkpoint": CHECKPOINT,
        "mel_input_shape": list(mel_b.shape), "block0_output_shape": list(block0_output.shape),
        "n_head": 20,
    }
    with open(os.path.join(OUT_DIR, "whisper_real_encoder_block.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("mel_input", mel_b.shape, "-> block0_output", block0_output.shape)
    print("done ->", OUT_DIR)
