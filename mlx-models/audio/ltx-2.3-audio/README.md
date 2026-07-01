# ltx-2.3-audio — LTX-2.3 Audio VAE + Vocoder

HF repo: `dgrauet/ltx-2.3-mlx-q8`

## 包含文件

- `audio_vae.safetensors` — 音頻 VAE（編碼 + 解碼器）
- `vocoder.safetensors` — BigVGAN vocoder + 帶寬延伸

## 用途

僅在 A2V 模式（`run.py video --audio ...`）下使用。T2V / I2V 模式不加載這些文件。
