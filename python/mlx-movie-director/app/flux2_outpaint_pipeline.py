"""flux2_outpaint_pipeline — Flux2 Klein outpainting/expansion via latent-mask re-injection.

Ports the ComfyUI "Flux2_Klein_Image expansion" workflow (CivitAI model 2326854,
version 2617507) to native MLX. That workflow is a latent-mask outpaint recipe:

  ImagePadForOutpaint (extend canvas + feather) → build mask (white = generate in
  the padded margins, black = keep the original) → VAEEncode → InpaintModelConditioning
  → DifferentialDiffusion (per-pixel denoising) → Flux2Scheduler (4 steps, euler,
  cfg=1) → VAEDecode.

Flux2 Klein has **no Fill/inpaint variant** in mflux (only Flux1 has variants/fill),
so outpainting is implemented as **latent re-injection**: at every denoise step the
original region's latent is forced back to its VAE-encoded value, and only the
masked (padded) margin tokens are allowed to denoise. This is the standard,
robust equivalent of ComfyUI's DifferentialDiffusion and is what makes the
original pixels survive bit-for-bit while new content is synthesised in the margins.

Model loading reuses the local pre-quantized INT8 symlink-assembly logic from
flux2_controlnet_pipeline.py (keeps ~17 GB of weights loaded across calls).

Latent-space notes (verified against mflux internals):
  - Generation latents live in the **batch-norm-normalised** packed space:
    decode_packed_latents() applies `packed * bn_std + bn_mean` before the VAE
    decoder, so the loop latents (initial mx.random.normal ≈ mean0/std1) and the
    converged image latents are both bn-normalised.
  - init_latent must therefore be built with the SAME transform as reference
    conditioning: encode_image → patchify → bn_normalize → pack.
  - Packed shape is [1, N, 128] with N = latent_height * latent_width and
    token order h * latent_width + w (row-major); the mask is reshaped to match.
"""

import os
import shutil
import sys
import tempfile
import time

from PIL import Image

from app import config as cfg
from app.pipeline_types import GenerationResult


# Ensure mflux is importable from the vendored submodule
_MFLUX_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "vendor", "mflux", "src",
)
if os.path.isdir(_MFLUX_SRC) and _MFLUX_SRC not in sys.path:
    sys.path.insert(0, _MFLUX_SRC)


class Flux2OutpaintModel:
    """Flux2KleinEdit extended with masked outpaint generation.

    Thin subclass wrapper: we cannot directly subclass Flux2KleinEdit across the
    vendored boundary without replicating its __init__, so instead we hold the
    model instance and reproduce its denoising loop with mask re-injection. The
    loop mirrors flux2_klein_edit.py generate_image() lines 88-130 exactly,
    adding one line after scheduler.step().
    """

    def __init__(self, model):
        # model is a fully-initialised Flux2KleinEdit instance
        self._m = model

    def generate_outpaint_image(
        self,
        *,
        seed: int,
        prompt: str,
        height: int,
        width: int,
        init_image_path: str,
        mask_latents,  # mx.array [1, N, 1], 1.0 = regenerate, 0.0 = keep original
        num_inference_steps: int = 4,
        guidance: float = 1.0,
        ref_strength: float = 1.0,
    ):
        """Generate an outpainted image.

        Args:
            init_image_path: Path to the PADDED source image (original centred on a
                larger canvas, already canvas-sized = width x height). Encoded to
                init_latent for re-injection AND used as the reference for coherence.
            mask_latents: Packed latent-space mask [1, N, 1] at the patch grid
                (latent_height x latent_width). 1.0 in the padded margins (regenerate),
                0.0 over the original (keep), feathered at the seam.
        """
        import mlx.core as mx
        from mflux.models.common.config.config import Config
        from mflux.models.common.latent_creator.latent_creator import LatentCreator
        from mflux.models.flux2.latent_creator.flux2_latent_creator import Flux2LatentCreator
        from mflux.models.flux2.variants.edit.flux2_klein_edit_helpers import _Flux2KleinEditHelpers
        from mflux.utils.image_util import ImageUtil

        model = self._m

        # 0. Config (image_strength=None → full-denoise noise latents; we manage
        #    the masked region ourselves, so no img2img noise interpolation here)
        config = Config(
            model_config=model.model_config,
            num_inference_steps=num_inference_steps,
            height=height,
            width=width,
            guidance=guidance,
            image_path=init_image_path,
            image_strength=None,
            scheduler="flow_match_euler_discrete",
        )

        # 1. Encode prompt(s) (guidance=1.0 → single forward pass, no negative branch)
        prompt_embeds, text_ids, negative_prompt_embeds, negative_text_ids = model._encode_prompt_pair(
            prompt=prompt,
            negative_prompt=" ",
            guidance=guidance,
        )

        # 2. Prepare generation (noise) latents  → packed [1, N, 128]
        latents, latent_ids, latent_height, latent_width = _Flux2KleinEditHelpers.prepare_generation_latents(
            seed=seed,
            height=config.height,
            width=config.width,
        )

        # 3. Build init_latent: VAE-encode the PADDED source through the SAME
        #    transform as reference conditioning (patchify → bn-normalise → pack),
        #    so it sits in the identical bn-normalised packed space as `latents`.
        encoded = LatentCreator.encode_image(
            vae=model.vae,
            image_path=init_image_path,
            height=config.height,
            width=config.width,
            tiling_config=model.tiling_config,
        )
        encoded = _Flux2KleinEditHelpers.ensure_4d_latents(encoded)
        encoded = _Flux2KleinEditHelpers.crop_to_even_spatial(encoded)
        encoded = Flux2LatentCreator.patchify_latents(encoded)
        encoded = _Flux2KleinEditHelpers.bn_normalize_vae_encoded_latents(encoded, vae=model.vae)
        init_latent = Flux2LatentCreator.pack_latents(encoded)  # [1, N, 128]
        mx.eval(init_latent)

        # 4. Reference conditioning (padded source as reference for content coherence)
        image_latents, image_latent_ids = _Flux2KleinEditHelpers.prepare_reference_image_conditioning(
            vae=model.vae,
            tiling_config=model.tiling_config,
            image_paths=[init_image_path],
            height=config.height,
            width=config.width,
            batch_size=latents.shape[0],
        )

        # Align mask dtype/spatial layout with the generation latents
        mask = mask_latents.astype(latents.dtype)
        N = latents.shape[1]
        if mask.shape[1] != N:
            raise ValueError(
                f"mask token count {mask.shape[1]} != latent token count {N} "
                f"(latent grid {latent_height}x{latent_width})"
            )

        # 5. Denoising loop (mirror Flux2KleinEdit.generate_image) + mask re-injection
        ctx = model.callbacks.start(seed=seed, prompt=prompt, config=config)
        ctx.before_loop(latents)
        predict = model._predict(model.transformer)
        for t in config.time_steps:
            try:
                noise = predict(
                    latents=latents,
                    image_latents=image_latents,
                    latent_ids=latent_ids,
                    image_latent_ids=image_latent_ids,
                    prompt_embeds=prompt_embeds,
                    text_ids=text_ids,
                    negative_prompt_embeds=negative_prompt_embeds,
                    negative_text_ids=negative_text_ids,
                    guidance=guidance,
                    timestep=config.scheduler.timesteps[t],
                )

                step_out = config.scheduler.step(
                    noise=noise, timestep=t, latents=latents, sigmas=config.scheduler.sigmas
                )

                # MASK RE-INJECTION — the core outpaint step:
                # original region (mask 0) held to its encoded latent → preserved;
                # padded margins (mask 1) take the denoised step → new content.
                latents = mask * step_out + (1.0 - mask) * init_latent

                ctx.in_loop(t, latents)
                mx.eval(latents)
            except KeyboardInterrupt:  # noqa: PERF203
                ctx.interruption(t, latents)
                from mflux.utils.exceptions import StopImageGenerationException
                raise StopImageGenerationException(
                    f"Stopping outpaint generation at step {t + 1}/{config.num_inference_steps}"
                )

        ctx.after_loop(latents)

        # 6. Decode (identical to Flux2KleinEdit.generate_image)
        packed_latents = latents.reshape(
            latents.shape[0], latent_height, latent_width, latents.shape[-1]
        ).transpose(0, 3, 1, 2)  # fmt: off
        decoded = model.vae.decode_packed_latents(packed_latents)
        return ImageUtil.to_image(
            decoded_latents=decoded,
            config=config,
            seed=seed,
            prompt=prompt,
            negative_prompt=None,
            quantization=model.bits,
            image_paths=[init_image_path],
            image_path=config.image_path,
            generation_time=config.time_steps.format_dict["elapsed"],
        )


class Flux2OutpaintPipeline:
    """Loads Flux2 Klein once and runs masked outpaint expansions across calls.

    Mirrors Flux2KleinControlnetPipeline's model-loading discipline (local INT8
    symlink assembly, LoRA application, model kept in memory).
    """

    def __init__(
        self,
        model_path: str | None = None,
        quantize: int | None = None,
        variant: str = "9b",
        transformer_name: str = "klein-9b",
        lora_paths: list[str] | None = None,
        lora_scales: list[float] | None = None,
    ):
        from mflux.models.flux2.variants.edit.flux2_klein_edit import Flux2KleinEdit
        from mflux.models.common.config.model_config import ModelConfig

        if variant == "9b":
            model_config = ModelConfig.flux2_klein_9b()
            transformer_dir = os.path.join(cfg.MODELS_DIR, "transformer", transformer_name)
            local_dirs = {
                "transformer":  transformer_dir,
                "text_encoder": cfg.KLEIN_9B_TEXT_ENCODER_DIR,
                "vae":          cfg.KLEIN_9B_VAE_DIR,
                "tokenizer":    cfg.KLEIN_9B_TOKENIZER_DIR,
            }
        else:
            model_config = ModelConfig.flux2_klein_4b()
            local_dirs = None

        resolved_path = model_path
        effective_quantize = quantize
        assembly_dir = None

        if resolved_path is None and local_dirs and all(
            os.path.isdir(d) for d in local_dirs.values()
        ):
            assembly_dir = tempfile.mkdtemp(prefix=f"klein_outpaint_{variant}_")
            for name, src in local_dirs.items():
                os.symlink(src, os.path.join(assembly_dir, name))
            resolved_path = assembly_dir
            effective_quantize = None
            print(f"[Flux2Outpaint] Using local pre-quantized INT8 ({variant})")
        else:
            source = resolved_path or "HF auto-download"
            print(f"[Flux2Outpaint] Loading Klein {variant.upper()} "
                  f"(quantize={quantize}, {source})...")

        if lora_paths:
            print(f"[Flux2Outpaint] Applying {len(lora_paths)} LoRA(s): "
                  f"{', '.join(os.path.basename(p) for p in lora_paths)}")

        t0 = time.time()
        klein = Flux2KleinEdit(
            model_config=model_config,
            model_path=resolved_path,
            quantize=effective_quantize,
            lora_paths=lora_paths,
            lora_scales=lora_scales,
        )
        self._model = Flux2OutpaintModel(klein)
        elapsed = time.time() - t0
        print(f"[Flux2Outpaint] Model ready.  (load: {elapsed:.1f}s)")

        if assembly_dir:
            shutil.rmtree(assembly_dir, ignore_errors=True)

    def expand(
        self,
        *,
        padded_image,            # PIL.Image — original centred on the expanded canvas
        mask_image,              # PIL.Image (L mode) — 255 = regenerate, 0 = keep
        width: int,
        height: int,
        prompt: str,
        steps: int = 4,
        seed: int = 42,
        ref_strength: float = 1.0,
    ) -> GenerationResult:
        """Outpaint one image.

        Args:
            padded_image: The source pasted onto a larger canvas, already sized to
                (width, height). The original region's latent is re-injected each step.
            mask_image: Grayscale (L) mask at the SAME (width, height); white (255) in
                the padded margins to regenerate, black (0) over the original to keep.
            width / height: Canvas size (must be multiples of 16).
            prompt: Text prompt describing the content to fill the margins.
            steps: Denoising steps (4 is typical for distilled Klein).
            seed: RNG seed.
            ref_strength: Reference conditioning strength (1.0 = full coherence lock).
        """
        import mlx.core as mx
        import numpy as np

        # Persist padded + mask images to temp (encode_image reads from file paths)
        tmp_init = None
        try:
            fd, tmp_init = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            padded_image.save(tmp_init)

            # Build packed latent-space mask [1, N, 1] from the pixel mask:
            # downsample to the patch grid (latent_height x latent_width = H/16 x W/16)
            # by block-mean, then flatten row-major to match the latent token order.
            vae_scale = 8
            latent_h = (2 * (height // (vae_scale * 2))) // 2  # = height // 16
            latent_w = (2 * (width // (vae_scale * 2))) // 2
            mask_arr = np.asarray(mask_image.convert("L"), dtype=np.float32) / 255.0
            # block-mean downsample to [latent_h, latent_w]
            bh = height // latent_h
            bw = width // latent_w
            mask_ds = mask_arr.reshape(latent_h, bh, latent_w, bw).mean(axis=(1, 3))
            mask_latents = mx.array(mask_ds.reshape(1, latent_h * latent_w, 1))

            result = self._model.generate_outpaint_image(
                seed=seed % (2 ** 32),
                prompt=prompt,
                height=height,
                width=width,
                init_image_path=tmp_init,
                mask_latents=mask_latents,
                num_inference_steps=steps,
                guidance=1.0,  # distilled Klein: no CFG
                ref_strength=ref_strength,
            )

            # Final composite: paste the true original pixels back into the kept
            # region (mask 0) and keep the generated content in the margins (mask 1),
            # blended across the feathered seam. The latent re-injection alone only
            # preserves the original to within a VAE encode→decode round-trip; this
            # pass makes the kept region bit-perfect and hides any round-trip drift.
            gen = np.asarray(result.image.convert("RGB"), dtype=np.float32)
            pad = np.asarray(padded_image.convert("RGB"), dtype=np.float32)
            m = mask_arr[..., None]  # [H, W, 1], broadcast over RGB
            final = (1.0 - m) * pad + m * gen
            final_img = Image.fromarray(np.clip(final, 0, 255).astype(np.uint8), mode="RGB")
            return GenerationResult(image=final_img, timings={})
        finally:
            if tmp_init and os.path.exists(tmp_init):
                os.unlink(tmp_init)
