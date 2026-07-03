# qwen-image-vae

`AutoencoderKLQwenImage` — f8 spatial compression, 16-channel latent, for Krea 2
(and the Qwen-Image family).

For single-image (T=1) the 3D causal convs collapse to 2D (only the last
temporal weight plane contributes). `config.json` holds the per-channel
`latents_mean` / `latents_std` (16 channels) used to rescale latents to/from
diffusion space.

Parity-validated in Python against diffusers: decode max-diff 0.0166, **encode
max-diff 3e-4**. Both decode + encode are ported to native Swift
(`Krea2VAE.decode` / `.encode`) and covered by `Krea2VAEParityTests`.
