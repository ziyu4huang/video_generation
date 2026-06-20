# TODO — klein-9b-dark-beast-bfs

## Status: BROKEN (base weights only, no fine-tuning)

The model directory was accidentally overwritten on 2026-06-21 when `convert.py` was run
against `darkBeast_dbzit9DIMRclaw_fp8.safetensors` (a ZIT model, not Klein 9B).
Current shards contain only base klein-9b weights.

---

## TODO

- [ ] Verify `darkBeast_dbzit9DIMRclaw.safetensors` (no `_fp8`) in Downloads is Klein 9B format
      ```bash
      python3 -c "
      from safetensors import safe_open
      with safe_open('/Users/huangziyu/Downloads/darkBeast_dbzit9DIMRclaw.safetensors', framework='pt') as f:
          keys = list(f.keys())[:5]
      print(keys)
      "
      ```
      Expected: keys starting with `double_blocks.` or `single_blocks.`

- [ ] Re-convert using the correct checkpoint:
      ```bash
      python/venv/bin/python python/mlx-movie-director/convert.py \
        --klein-9b-checkpoint /Users/huangziyu/Downloads/darkBeast_dbzit9DIMRclaw.safetensors \
        --name klein-9b-dark-beast-bfs
      ```

- [ ] Restore manifest.json after convert (convert.py deletes it via shutil.rmtree):
      ```bash
      # manifest.json content is in README.md — or copy from kleinova-nsfw-v22/manifest.json
      # and update name, description, source, source_url fields
      ```

- [ ] Test generation — confirm no burlap texture:
      ```bash
      python/venv/bin/python python/mlx-movie-director/run.py image t2i \
        --pipeline flux2-klein --transformer klein-9b-dark-beast-bfs \
        --prompt "a portrait of a woman, photorealistic" --steps 20 --cfg-scale 3.5
      ```

- [ ] Remove this TODO.md (or mark all tasks done) once restored and verified

## Next

If `darkBeast_dbzit9DIMRclaw.safetensors` is confirmed as Klein 9B format → run the
conversion immediately (fix already in `convert.py`, no code changes needed).

If it turns out to also be ZIT format → re-download modelVersionId=2740209 from
https://civitai.com/models/2242173/dark-beast-or?modelVersionId=2740209
and look for the BF16/non-FP8 variant.
