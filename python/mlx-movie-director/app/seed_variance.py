"""Seed Variance Enhancer — adds noise to text embeddings during early denoising.

Inspired by ComfyUI's SeedVarianceEnhancer v2.2 node. Perturbs a percentage
of text conditioning values with random noise during the first N denoising
steps, then switches to the clean embedding. This produces more diverse and
natural outputs from the same seed without changing generation quality.
"""

import mlx.core as mx
import numpy as np


class SeedVarianceEnhancer:
    """Creates a noisy text embedding for early denoising steps.

    Parameters:
      randomize_percent: Percentage of embedding values to perturb (0–100)
      strength: Noise scale factor (typical: 10–30)
      switchover_percent: Use noisy embedding for the first N% of steps (0–100)
    """

    def __init__(self, randomize_percent: float = 50.0,
                 strength: float = 20.0,
                 switchover_percent: float = 20.0):
        self.randomize_percent = randomize_percent
        self.strength = strength
        self.switchover_percent = switchover_percent

    def create_noisy_embedding(self, cap_feats_mx: mx.array,
                               seed: int | None = None) -> mx.array:
        """Create a noisy copy of the text embedding.

        Args:
            cap_feats_mx: Clean text embedding, shape (1, seq_len, dim)
            seed: Optional seed for reproducibility

        Returns:
            Noisy embedding with same shape as input
        """
        if seed is not None:
            np.random.seed(seed + 9999)  # Offset to avoid collision with denoise seed

        arr = np.array(cap_feats_mx.astype(mx.float32))

        # Create random mask: True where we perturb
        total_values = arr.size
        num_to_perturb = int(total_values * self.randomize_percent / 100.0)
        mask = np.zeros(total_values, dtype=bool)
        if num_to_perturb > 0:
            indices = np.random.choice(total_values, num_to_perturb, replace=False)
            mask[indices] = True
        mask = mask.reshape(arr.shape)

        # Generate noise scaled by strength
        noise = np.random.randn(*arr.shape).astype(np.float32) * self.strength

        # Apply noise only to masked positions
        noisy = arr.copy()
        noisy[mask] += noise[mask]

        return mx.array(noisy).astype(cap_feats_mx.dtype)

    def should_use_noisy(self, step: int, total_steps: int) -> bool:
        """Whether to use the noisy embedding at this step."""
        if self.switchover_percent <= 0:
            return False
        if self.switchover_percent >= 100:
            return True
        cutoff = int(total_steps * self.switchover_percent / 100.0)
        return step < cutoff
