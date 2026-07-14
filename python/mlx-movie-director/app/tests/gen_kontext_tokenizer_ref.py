#!/usr/bin/env python3
"""Generate FLUX.1-Kontext-dev CLIP/T5 tokenizer reference ids for Swift
tokenizer verification (kontext epic phase 5 prerequisite, see
output/next-goal-20260714_223500.md).

Tokenizes a fixed, deliberately varied prompt set (plain ASCII, punctuation,
contractions, multi-space runs, accented Latin, CJK, empty string) with the
REAL HF `CLIPTokenizer` (legacy vocab.json+merges.txt path) and
`T5TokenizerFast` (Unigram + Precompiled-normalizer path), and saves
input_ids as JSON. The Swift port (`KontextCLIPTokenizer`/`KontextT5Tokenizer`)
must match these EXACTLY, token-for-token — not just in length — for
`flux2 verify-kontext-clip-tokenizer`/`verify-kontext-t5-tokenizer` to pass.

Run from repo root:
    python/venv/bin/python python/mlx-movie-director/app/tests/gen_kontext_tokenizer_ref.py
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "python" / "mlx-movie-director" / "vendor" / "mflux" / "src"))
sys.path.insert(0, str(REPO.parent / "mflux" / "src"))

from huggingface_hub import snapshot_download
from transformers import CLIPTokenizer, T5TokenizerFast

OUT_DIR = REPO / "swift" / "flux2-image-director" / "verify_refs"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_ID = "black-forest-labs/FLUX.1-Kontext-dev"
CLIP_MAX_LENGTH = 77
T5_MAX_LENGTH = 64

PROMPTS = [
    "a photo of an astronaut riding a horse on the moon",
    "A CAT sitting on a Windowsill!!",
    "multi-word-hyphenated  and   extra   spaces",
    "it's a beautiful day, isn't it?",
    "café résumé naïve",
    "日本語のテスト",
    "",
    "a red bicycle, 4k, photorealistic, cinematic lighting",
    "version 2.0, 100% done, cost $9.99",
    "emoji test 🎨🖼️ generative art",
    " leading and trailing spaces  ",
    " ".join(["word"] * 100),
]

root = Path(snapshot_download(repo_id=MODEL_ID, allow_patterns=["tokenizer/*", "tokenizer_2/*"]))
clip_tokenizer = CLIPTokenizer.from_pretrained(str(root / "tokenizer"))
t5_tokenizer = T5TokenizerFast.from_pretrained(str(root / "tokenizer_2"))

out = {"clip": [], "t5": []}
for p in PROMPTS:
    clip_ids = clip_tokenizer(p, padding="max_length", max_length=CLIP_MAX_LENGTH, truncation=True)["input_ids"]
    t5_ids = t5_tokenizer(p, padding="max_length", max_length=T5_MAX_LENGTH, truncation=True)["input_ids"]
    out["clip"].append({"prompt": p, "ids": clip_ids})
    out["t5"].append({"prompt": p, "ids": t5_ids})

out_path = OUT_DIR / "kontext_tokenizer_ref.json"
out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1))
print(f"Saved tokenizer reference to: {out_path}")
for item in out["clip"]:
    print(f"  CLIP {item['prompt']!r} -> {len(item['ids'])} ids")
for item in out["t5"]:
    print(f"  T5   {item['prompt']!r} -> {len(item['ids'])} ids")
