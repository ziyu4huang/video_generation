# musicgen-small — MusicGen Text-to-Music Checkpoint

MusicGen text-to-music checkpoint (facebook/musicgen-small), split into text_encoder (t5-base) / decoder (24-layer causal+cross-attn LM) / audio_encoder (EnCodec 32kHz) for the swift/musicgen-director port.

Source: [facebook/musicgen-small](https://huggingface.co/facebook/musicgen-small)

## Usage

```bash
swift run --package-path swift/musicgen-director musicgen generate \
  --prompt 'warm acoustic guitar, gentle, 90bpm'
```

## Notes

- Format: fp32 MLX safetensors, split from the upstream merged checkpoint
- `text_encoder.safetensors` / `decoder.safetensors` / `audio_encoder.safetensors`,
  each with a matching `<component>_config.json` copied from the upstream config
- `decoder.safetensors` also carries `enc_to_dec_proj.{weight,bias}`
  (T5-hidden -> decoder-cross-attn projection)
- Imported via `run.py import-musicgen`
