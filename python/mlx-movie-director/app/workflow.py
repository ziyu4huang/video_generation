"""Multi-stage workflow orchestrator for the Z-Image pipeline.

Chains: base generation → face detailer → post-processing → upscale
into a single CLI invocation with per-generation subfolder output.

Usage:
    run.py image workflow --prompt "..." --face-detail --film-grain 0.02 --upscale
"""

import gc
import json
import os
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

import mlx.core as mx
from PIL import Image

from app import config as cfg
from app.pipeline_types import GenerationResult, WorkflowResult


class WorkflowOrchestrator:
    """Orchestrates a multi-stage image generation workflow.

    Stage 1: Base Generation (T2I or I2I via ZImagePipeline)
    Stage 2: Face Detailer (optional)
    Stage 3: Post-Processing (optional)
    Stage 4: Upscale (optional)
    """

    def __init__(self, run_config):
        """
        Args:
            run_config: A RunConfig instance with all generation parameters
        """
        self.config = run_config

    def execute(self) -> WorkflowResult:
        """Execute all workflow stages in sequence."""
        global_start = time.time()
        stage_images = {}
        stage_timings = {}

        # Resolve prompt
        prompt = self.config.prompt or ""
        if self.config.prompt_file:
            with open(self.config.prompt_file, "r") as f:
                prompt = f.read().strip()
        if not prompt:
            raise ValueError("No prompt provided. Use --prompt or --prompt-file.")

        # --- Stage 1: Base Generation ---
        print(f"\n{'='*60}")
        print(f"[Stage 1/4] Base Generation")
        print(f"{'='*60}")
        current_image, t1 = self._run_base_generation(prompt)
        stage_images["base"] = current_image
        stage_timings["base"] = t1

        # --- Stage 2: Face Detailer ---
        if self.config.face_detail:
            self._cleanup()
            print(f"\n{'='*60}")
            print(f"[Stage 2/4] Face Detailer")
            print(f"{'='*60}")
            image_before = current_image
            current_image, t2 = self._run_face_detailer(current_image, prompt)
            # Only record if face detailer actually modified the image
            if current_image is not image_before:
                stage_images["face_detail"] = current_image
                stage_timings["face_detail"] = t2

        # --- Stage 3: Post-Processing ---
        has_post = self._has_post_processing()
        if has_post:
            print(f"\n{'='*60}")
            print(f"[Stage 3/4] Post-Processing")
            print(f"{'='*60}")
            current_image, t3 = self._run_postprocess(current_image)
            stage_images["postprocess"] = current_image
            stage_timings["postprocess"] = t3

        # --- Stage 4: Upscale ---
        if self.config.upscale:
            self._cleanup()
            print(f"\n{'='*60}")
            print(f"[Stage 4/4] Upscale ({self.config.upscale_method})")
            print(f"{'='*60}")
            current_image, t4 = self._run_upscale(current_image)
            stage_images["upscale"] = current_image
            stage_timings["upscale"] = t4

        total_seconds = time.time() - global_start
        print(f"\n{'='*60}")
        print(f"Workflow completed in {total_seconds:.1f}s")
        print(f"{'='*60}")

        return WorkflowResult(
            final_image=current_image,
            stage_images=stage_images,
            stage_timings=stage_timings,
            total_seconds=total_seconds,
        )

    def _run_base_generation(self, prompt: str) -> tuple:
        """Stage 1: Generate base image via ZImagePipeline."""
        from app.pipeline import ZImagePipeline

        pipeline = ZImagePipeline()

        # Load input image for I2I
        input_image = None
        if self.config.input_image:
            input_image = Image.open(self.config.input_image).convert("RGB")

        result = pipeline.generate(
            prompt=prompt,
            width=self.config.width,
            height=self.config.height,
            steps=self.config.steps,
            seed=self.config.seed,
            lora_path=self.config.lora_path,
            lora_scale=self.config.lora_scale,
            input_image=input_image,
            latent_upscale=self.config.latent_upscale,
            denoise_strength=self.config.denoise_strength,
            seed_variance=self.config.seed_variance,
            seed_variance_percent=self.config.seed_variance_percent,
            seed_variance_strength=self.config.seed_variance_strength,
            seed_variance_switchover=self.config.seed_variance_switchover,
            upscale=False,  # We handle upscaling in Stage 4
        )

        return result.image, result.timings

    def _run_face_detailer(self, image: Image.Image, prompt: str) -> tuple:
        """Stage 2: Detect and enhance face details."""
        from app.face_detailer import detail_faces

        return detail_faces(
            image=image,
            prompt=prompt,
            seed=self.config.seed,
            denoise_strength=getattr(self.config, "face_detail_denoise", 0.15),
            steps=getattr(self.config, "face_detail_steps", 9),
            lora_path=getattr(self.config, "face_detail_lora", None),
        )

    def _has_post_processing(self) -> bool:
        """Check if any post-processing filters are configured."""
        return (
            getattr(self.config, "film_grain", 0) > 0
            or getattr(self.config, "sharpening", 0) > 0
            or getattr(self.config, "lut_path", None) is not None
            or getattr(self.config, "skin_contrast", False)
            or getattr(self.config, "noise_clean", False)
        )

    def _run_postprocess(self, image: Image.Image) -> tuple:
        """Stage 3: Apply post-processing filter chain."""
        from app.postprocess import PostProcessChain

        chain = PostProcessChain.from_config({
            "film_grain": getattr(self.config, "film_grain", 0),
            "sharpening": getattr(self.config, "sharpening", 0),
            "lut_path": getattr(self.config, "lut_path", None),
            "lut_strength": getattr(self.config, "lut_strength", 0.3),
            "skin_contrast": getattr(self.config, "skin_contrast", False),
            "noise_clean": getattr(self.config, "noise_clean", False),
        })

        result, timings = chain.apply(image, seed=self.config.seed)
        for name, t in timings.items():
            print(f"    {name}: {t:.3f}s")
        return result, timings

    def _run_upscale(self, image: Image.Image) -> tuple:
        """Stage 4: Upscale via ESRGAN or SeedVR2."""
        from app.commands._shared import DEFAULT_UPSCALE_MODEL

        timings = {}
        upscale_model = self.config.upscale_model or DEFAULT_UPSCALE_MODEL

        # Validate model exists before proceeding
        if self.config.upscale_method != "seedvr2" and not os.path.exists(upscale_model):
            raise FileNotFoundError(
                f"Upscale model not found: {upscale_model}\n"
                f"  Download and place it in the expected path, or use --no-upscale."
            )

        w0, h0 = image.size
        t0 = time.time()

        if self.config.upscale_method == "seedvr2":
            from app.seedvr2.pipeline import SeedVR2Upscaler
            sv2 = SeedVR2Upscaler(model_size="7b")
            try:
                image = sv2.upscale(image, resolution=2.0, softness=0.5,
                                    seed=self.config.seed or 42)
            finally:
                sv2.unload()
        else:
            from app.pipeline import ZImagePipeline
            image = ZImagePipeline.upscale_esrgan(image, upscale_model)

        timings["upscale_seconds"] = time.time() - t0
        w1, h1 = image.size
        print(f"    {w0}x{h0} → {w1}x{h1} ({timings['upscale_seconds']:.2f}s)")
        return image, timings

    def _cleanup(self):
        """Free MLX memory between stages."""
        mx.clear_cache()
        gc.collect()

    @staticmethod
    def save_outputs(result: WorkflowResult, run_config, base_name: str | None = None):
        """Save all workflow outputs to a per-generation subfolder.

        Creates:
            output/workflow_YYYYMMDD_HHMMSS/
              final.png
              stage1_base.png
              stage2_face_detail.png  (if applicable)
              stage3_postprocess.png   (if applicable)
              stage4_upscale.png       (if applicable)
              config.json
        """
        if base_name is None:
            base_name = f"workflow_{time.strftime('%Y%m%d_%H%M%S')}"

        out_dir = os.path.join(cfg.OUTPUT_DIR, base_name)
        os.makedirs(out_dir, exist_ok=True)

        # Save stage images
        stage_order = ["base", "face_detail", "postprocess", "upscale"]
        for idx, stage_name in enumerate(stage_order, start=1):
            if stage_name in result.stage_images:
                path = os.path.join(out_dir, f"stage{idx}_{stage_name}.png")
                result.stage_images[stage_name].save(path)
                print(f"    Saved: {path}")

        # Save final image
        final_path = os.path.join(out_dir, "final.png")
        result.final_image.save(final_path)
        print(f"    Saved: {final_path}")

        # Save config
        config_path = os.path.join(out_dir, "config.json")
        config_data = asdict(run_config)
        config_data["workflow_timings"] = {
            k: v for k, v in result.stage_timings.items()
        }
        config_data["total_seconds"] = result.total_seconds
        with open(config_path, "w") as f:
            json.dump(config_data, f, indent=2, ensure_ascii=False, default=str)

        result.output_dir = out_dir
        return out_dir
