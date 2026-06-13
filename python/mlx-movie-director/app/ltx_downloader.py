"""ltx_downloader — Download LTX-2.3 MLX model files to component directories.

Usage:
    python app/ltx_downloader.py
    python app/ltx_downloader.py --dry-run
    python app/ltx_downloader.py --component transformer
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config as cfg

HF_REPO = "dgrauet/ltx-2.3-mlx-q8"

COMPONENT_FILES = {
    "transformer": (cfg.LTX_TRANSFORMER_DIR, [
        "transformer-dev.safetensors",
        "split_model.json",
        "quantize_config.json",
    ]),
    "transformer-distilled": (cfg.LTX_DISTILLED_TRANSFORMER_DIR, [
        "transformer-distilled-1.1.safetensors",
        "split_model.json",
        "quantize_config.json",
    ]),
    "lora": (cfg.LTX_LORA_DIR, [
        "ltx-2.3-22b-distilled-lora-384.int8.safetensors",
        "ltx-2.3-22b-distilled-lora-384-1.1.int8.safetensors",
    ]),
    "text_encoder": (cfg.LTX_TEXT_ENCODER_DIR, [
        "connector.safetensors",
        "config.json",
        "embedded_config.json",
    ]),
    "vae": (cfg.LTX_VAE_DIR, [
        "vae_encoder.safetensors",
        "vae_decoder.safetensors",
        "spatial_upscaler_x2_v1_1.safetensors",
        "spatial_upscaler_x2_v1_1_config.json",
        "spatial_upscaler_x1_5_v1_0.safetensors",
        "spatial_upscaler_x1_5_v1_0_config.json",
        "temporal_upscaler_x2_v1_0.safetensors",
        "temporal_upscaler_x2_v1_0_config.json",
    ]),
    "audio": (cfg.LTX_AUDIO_DIR, [
        "audio_vae.safetensors",
        "vocoder.safetensors",
    ]),
}

OPTIONAL_FILES = {
    "split_model.json",
    "quantize_config.json",
    "config.json",
    "embedded_config.json",
    "spatial_upscaler_x2_v1_1.safetensors",
    "spatial_upscaler_x1_5_v1_0.safetensors",
    "spatial_upscaler_x1_5_v1_0_config.json",
    "temporal_upscaler_x2_v1_0.safetensors",
    "temporal_upscaler_x2_v1_0_config.json",
}


def download_component(component: str, dest_dir: str, filenames: list[str],
                       dry_run: bool = False) -> None:
    from huggingface_hub import hf_hub_download, file_exists

    os.makedirs(dest_dir, exist_ok=True)
    print(f"\n[{component}] → {dest_dir}")

    for fname in filenames:
        dest_path = os.path.join(dest_dir, fname)
        if os.path.exists(dest_path):
            size_mb = os.path.getsize(dest_path) / 1024**2
            print(f"  ✓ {fname} ({size_mb:.1f} MB) — already exists")
            continue

        is_optional = fname in OPTIONAL_FILES
        try:
            if dry_run:
                print(f"  → {fname} (would download)")
                continue
            print(f"  ↓ {fname} …", end="", flush=True)
            hf_hub_download(
                repo_id=HF_REPO,
                filename=fname,
                local_dir=dest_dir,
            )
            size_mb = os.path.getsize(dest_path) / 1024**2
            print(f" done ({size_mb:.1f} MB)")
        except Exception as e:
            if is_optional:
                print(f" skipped (optional: {e})")
            else:
                print(f" FAILED: {e}", file=sys.stderr)
                raise


def main():
    parser = argparse.ArgumentParser(
        description=f"Download LTX-2.3 model files from {HF_REPO}"
    )
    parser.add_argument("--component", choices=list(COMPONENT_FILES.keys()),
                        default=None,
                        help="Download only this component (default: all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be downloaded without downloading")
    args = parser.parse_args()

    components = (
        {args.component: COMPONENT_FILES[args.component]}
        if args.component
        else COMPONENT_FILES
    )

    print(f"HF repo: {HF_REPO}")
    if args.dry_run:
        print("DRY RUN — no files will be downloaded")

    for name, (dest_dir, filenames) in components.items():
        download_component(name, dest_dir, filenames, dry_run=args.dry_run)

    if not args.dry_run:
        print("\nDownload complete. Run 'check-manifests' to verify:")
        print("  python run.py check-manifests")
        print("\nNote: update size_bytes in manifests after download:")
        for name, (dest_dir, _) in components.items():
            print(f"  {dest_dir}/manifest.json")


if __name__ == "__main__":
    main()
