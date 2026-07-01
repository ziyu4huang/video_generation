# z-imageclearvae

Z-Image_clear_vae half-natural ZImage-Turbo VAE, converted to MLX BF16

## Details

| Field | Value |
|-------|-------|
| Type | VAE |
| Arch | flux-ae (ZImage AutoencoderKL, 16 latent channels) |
| Format | mlx-bf16 |
| Pipeline | zimage-turbo |
| Source | [https://civitai.com/models/2191617](https://civitai.com/models/2191617) |

## Notes

- Converted from CivitAI safetensors via `import-vae`
- `model.safetensors` is a symlink to `../video_generation__models/<md5>.safetensors`
- Compatible with ZImage-Turbo transformers (same 16-channel latent space)
