"""Image post-processing filters for the Z-Image workflow pipeline.

Pure numpy/PIL/cv2 image processing — no ML model loading needed.
Each filter implements apply(image) -> image for use in PostProcessChain.
"""

import math
import os
import time

import numpy as np
from PIL import Image


# ---------------------------------------------------------------------------
# Film Grain
# ---------------------------------------------------------------------------

class FilmGrain:
    """Add perceptual film grain to counteract AI smoothness.

    Parameters match ComfyUI LayerFilter AddGrain / FilmGrain nodes:
      intensity: noise scale (0.0–0.03 typical, 0.01 subtle, 0.03 heavy)
      temperature: RGB shift for warm/cool tint (0 = neutral)
      vignette: edge darkening amount (0 = none, 0.5 = moderate)
    """

    def __init__(self, intensity: float = 0.02, temperature: float = 0.0,
                 vignette: float = 0.0):
        self.intensity = intensity
        self.temperature = temperature
        self.vignette = vignette
        self.name = "film_grain"

    def apply(self, image: Image.Image, seed: int | None = None) -> Image.Image:
        rng = np.random.default_rng(seed)
        arr = np.array(image, dtype=np.float32) / 255.0

        # Add Gaussian noise
        noise = rng.normal(0, self.intensity, arr.shape).astype(np.float32)
        arr = np.clip(arr + noise, 0.0, 1.0)

        # Temperature shift (warm: positive, cool: negative)
        if self.temperature != 0:
            temp = np.array([self.temperature, 0.0, -self.temperature], dtype=np.float32)
            arr = np.clip(arr + temp, 0.0, 1.0)

        # Vignette
        if self.vignette > 0:
            h, w = arr.shape[:2]
            Y, X = np.ogrid[:h, :w]
            cx, cy = w / 2, h / 2
            dist = np.sqrt((X - cx) ** 2 + (Y - cy) ** 2)
            max_dist = np.sqrt(cx ** 2 + cy ** 2)
            falloff = 1.0 - self.vignette * (dist / max_dist) ** 2
            arr = np.clip(arr * falloff[:, :, np.newaxis], 0.0, 1.0)

        return Image.fromarray((arr * 255).round().astype("uint8"))


# ---------------------------------------------------------------------------
# Sharpening (CAS + Unsharp Mask)
# ---------------------------------------------------------------------------

class Sharpening:
    """Contrast Adaptive Sharpening (CAS) and/or unsharp mask.

    Parameters:
      cas_strength: CAS sharpening amount (0.0–1.0, 0.1 subtle)
      unsharp_radius: Gaussian blur radius for unsharp mask (0 = skip)
      unsharp_amount: Unsharp mask strength (0.0–2.0, typical 0.5–1.0)
    """

    def __init__(self, cas_strength: float = 0.1, unsharp_radius: int = 0,
                 unsharp_amount: float = 0.0):
        self.cas_strength = cas_strength
        self.unsharp_radius = unsharp_radius
        self.unsharp_amount = unsharp_amount
        self.name = "sharpening"

    def apply(self, image: Image.Image) -> Image.Image:
        arr = np.array(image, dtype=np.float32)

        if self.cas_strength > 0:
            arr = self._cas(arr, self.cas_strength)

        if self.unsharp_radius > 0 and self.unsharp_amount > 0:
            arr = self._unsharp(arr, self.unsharp_radius, self.unsharp_amount)

        arr = np.clip(arr, 0, 255).round().astype("uint8")
        return Image.fromarray(arr)

    @staticmethod
    def _cas(img: np.ndarray, strength: float) -> np.ndarray:
        """Contrast Adaptive Sharpening (AMD FidelityFX CAS algorithm).

        For each pixel, computes a weight based on local contrast and blends
        the pixel with its max/min neighbors.
        """
        # Pad for 3x3 kernel
        padded = np.pad(img, ((1, 1), (1, 1), (0, 0)), mode="reflect")
        h, w, c = img.shape

        # Gather 3x3 neighborhood
        center = padded[1:-1, 1:-1]
        up     = padded[:-2, 1:-1]
        down   = padded[2:,  1:-1]
        left   = padded[1:-1, :-2]
        right  = padded[1:-1, 2:]

        # Min/Max of cross (+diagonals for better quality)
        cross_max = np.maximum(np.maximum(up, down),
                               np.maximum(left, right))
        cross_min = np.minimum(np.minimum(up, down),
                               np.minimum(left, right))

        # Blend weight: lower contrast → more sharpening
        diff = cross_max - cross_min
        # Avoid division by zero
        weight = np.where(diff > 0.001,
                          np.minimum(0.125 / (diff + 0.001), 1.0) * strength,
                          1.0)

        # Weighted average of neighborhood
        avg = (up + down + left + right) / 4.0
        result = center + weight * (center - avg)

        return np.clip(result, 0, 255)

    @staticmethod
    def _unsharp(img: np.ndarray, radius: int, amount: float) -> np.ndarray:
        """Unsharp mask: original + amount * (original - blurred)."""
        from PIL import Image as PILImage
        pil = PILImage.fromarray(img.round().astype("uint8"))
        blurred = pil.filter(Image.GaussianBlur(radius=radius))
        blurred_arr = np.array(blurred, dtype=np.float32)
        return img + amount * (img - blurred_arr)


# ---------------------------------------------------------------------------
# Noise / JPEG Artifact Cleaner
# ---------------------------------------------------------------------------

class NoiseCleaner:
    """Denoise and reduce JPEG compression artifacts.

    Methods:
      bilateral: Edge-preserving bilateral filter (cv2)
      jpeg_scrub: Slight blur + sharpen to reduce blocking artifacts
    """

    def __init__(self, bilateral_d: int = 9, bilateral_sigma: float = 75.0,
                 jpeg_scrub: bool = True):
        self.bilateral_d = bilateral_d
        self.bilateral_sigma = bilateral_sigma
        self.jpeg_scrub = jpeg_scrub
        self.name = "noise_cleaner"

    def apply(self, image: Image.Image) -> Image.Image:
        try:
            import cv2
        except ImportError:
            print("  [NoiseCleaner] opencv-python not available — skipping")
            return image

        arr = np.array(image)

        # Bilateral filter for noise reduction
        if self.bilateral_d > 0:
            arr = cv2.bilateralFilter(arr, self.bilateral_d,
                                      self.bilateral_sigma, self.bilateral_sigma)

        # JPEG artifact scrub: slight blur to smooth blocking, then sharpen
        if self.jpeg_scrub:
            blurred = cv2.GaussianBlur(arr, (3, 3), 0.5)
            # Unsharp mask to restore edge detail
            arr = np.clip(
                arr.astype(np.float32) + 0.3 * (arr.astype(np.float32) - blurred.astype(np.float32)),
                0, 255
            ).astype(np.uint8)

        return Image.fromarray(arr)


# ---------------------------------------------------------------------------
# LUT Color Grading (.cube 3D LUT)
# ---------------------------------------------------------------------------

class LUTGrading:
    """Apply a 3D LUT (.cube file) for color grading.

    Parses the .cube format and applies trilinear interpolation to remap
    pixel colors. Blends with original at the specified strength.

    Parameters:
      lut_path: Path to .cube file
      strength: Blend factor with original (0.0 = no change, 1.0 = full LUT)
    """

    def __init__(self, lut_path: str, strength: float = 0.3):
        self.lut_path = lut_path
        self.strength = strength
        self.name = "lut_grading"
        self._lut = None  # Loaded lazily

    def _parse_cube(self, path: str) -> np.ndarray:
        """Parse a .cube 3D LUT file.

        Returns a numpy array of shape (size, size, size, 3) with float32 RGB values.
        """
        lut_size = None
        lut_data = []

        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("LUT_3D_SIZE"):
                    lut_size = int(line.split()[1])
                    continue
                if line.startswith("TITLE") or line.startswith("DOMAIN"):
                    continue
                # Data line: R G B
                try:
                    values = [float(v) for v in line.split()]
                    if len(values) == 3:
                        lut_data.append(values)
                except ValueError:
                    continue

        if lut_size is None:
            lut_size = round(len(lut_data) ** (1.0 / 3.0))

        if len(lut_data) != lut_size ** 3:
            raise ValueError(
                f"LUT data mismatch: expected {lut_size ** 3} entries, got {len(lut_data)}"
            )

        lut = np.array(lut_data, dtype=np.float32).reshape(lut_size, lut_size, lut_size, 3)
        return lut

    def _trilinear_interpolate(self, lut: np.ndarray, rgb: np.ndarray) -> np.ndarray:
        """Trilinear interpolation in 3D LUT.

        rgb: (N, 3) float32 array with values in [0, 1]
        Returns: (N, 3) float32 with remapped colors
        """
        size = lut.shape[0]
        scale = (size - 1)

        # Scale to LUT indices
        coords = rgb * scale  # (N, 3)
        coords = np.clip(coords, 0, size - 1)

        # Integer and fractional parts
        idx = coords.astype(np.int32)
        frac = coords - idx

        # Clamp upper index
        idx1 = np.minimum(idx + 1, size - 1)

        # Trilinear interpolation: 8 corners of the cube.
        # .cube format: R changes fastest → reshaped array is indexed [B, G, R].
        r, g, b = idx[:, 0], idx[:, 1], idx[:, 2]
        r1, g1, b1 = idx1[:, 0], idx1[:, 1], idx1[:, 2]
        c000 = lut[b,  g,  r ]
        c001 = lut[b1, g,  r ]
        c010 = lut[b,  g1, r ]
        c011 = lut[b1, g1, r ]
        c100 = lut[b,  g,  r1]
        c101 = lut[b1, g,  r1]
        c110 = lut[b,  g1, r1]
        c111 = lut[b1, g1, r1]

        fx, fy, fz = frac[:, 0:1], frac[:, 1:2], frac[:, 2:3]

        result = (c000 * (1 - fx) * (1 - fy) * (1 - fz) +
                  c001 * (1 - fx) * (1 - fy) * fz +
                  c010 * (1 - fx) * fy * (1 - fz) +
                  c011 * (1 - fx) * fy * fz +
                  c100 * fx * (1 - fy) * (1 - fz) +
                  c101 * fx * (1 - fy) * fz +
                  c110 * fx * fy * (1 - fz) +
                  c111 * fx * fy * fz)

        return result

    def apply(self, image: Image.Image) -> Image.Image:
        if self._lut is None:
            self._lut = self._parse_cube(self.lut_path)

        arr = np.array(image, dtype=np.float32) / 255.0
        h, w, c = arr.shape

        # Flatten to (N, 3) for batch interpolation
        flat = arr.reshape(-1, 3)
        remapped = self._trilinear_interpolate(self._lut, flat)

        # Blend with original at self.strength
        blended = flat * (1 - self.strength) + remapped * self.strength
        blended = np.clip(blended, 0.0, 1.0)

        result = (blended.reshape(h, w, c) * 255).round().astype("uint8")
        return Image.fromarray(result)


# ---------------------------------------------------------------------------
# Skin Contrast Enhancement
# ---------------------------------------------------------------------------

class SkinContrast:
    """Selective contrast enhancement for skin-tone regions.

    Detects skin pixels via HSV color range and applies CLAHE
    (Contrast Limited Adaptive Histogram Equalization) to skin regions only.
    """

    def __init__(self, clip_limit: float = 2.0, tile_grid_size: int = 8):
        self.clip_limit = clip_limit
        self.tile_grid_size = tile_grid_size
        self.name = "skin_contrast"

    def apply(self, image: Image.Image) -> Image.Image:
        try:
            import cv2
        except ImportError:
            print("  [SkinContrast] opencv-python not available — skipping")
            return image

        arr = np.array(image)
        hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)

        # Skin tone range in HSV (works for most skin tones)
        lower_skin = np.array([0, 30, 60], dtype=np.uint8)
        upper_skin = np.array([25, 180, 255], dtype=np.uint8)
        skin_mask = cv2.inRange(hsv, lower_skin, upper_skin)

        # Also catch darker skin tones
        lower_skin2 = np.array([170, 30, 60], dtype=np.uint8)
        upper_skin2 = np.array([180, 180, 255], dtype=np.uint8)
        skin_mask2 = cv2.inRange(hsv, lower_skin2, upper_skin2)
        skin_mask = cv2.bitwise_or(skin_mask, skin_mask2)

        # Dilate mask slightly to cover edges
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        skin_mask = cv2.dilate(skin_mask, kernel, iterations=1)

        # Apply CLAHE to luminance channel
        lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)
        clahe = cv2.createCLAHE(clipLimit=self.clip_limit,
                                tileGridSize=(self.tile_grid_size, self.tile_grid_size))
        lab[:, :, 0] = clahe.apply(lab[:, :, 0])

        # Apply only to skin regions
        enhanced = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
        result = np.where(skin_mask[:, :, np.newaxis] > 0, enhanced, arr)

        return Image.fromarray(result.astype("uint8"))


# ---------------------------------------------------------------------------
# Post-Processing Chain
# ---------------------------------------------------------------------------

class PostProcessChain:
    """Configurable chain of post-processing filters.

    Usage:
        chain = PostProcessChain.from_config({
            "film_grain": 0.02,
            "sharpening": 0.1,
            "lut_path": "models/lut/NaturalBoost.cube",
            "lut_strength": 0.3,
            "skin_contrast": True,
            "noise_clean": False,
        })
        result_image, timings = chain.apply(input_image)
    """

    def __init__(self, filters: list):
        self.filters = filters

    @classmethod
    def from_config(cls, config: dict) -> "PostProcessChain":
        """Build a filter chain from a configuration dict."""
        filters = []

        # Noise cleaning first (clean up before enhancing)
        if config.get("noise_clean"):
            filters.append(NoiseCleaner())

        # Skin contrast
        if config.get("skin_contrast"):
            filters.append(SkinContrast())

        # Sharpening
        sharp = config.get("sharpening", 0)
        if sharp > 0:
            filters.append(Sharpening(cas_strength=sharp))

        # LUT color grading
        lut_path = config.get("lut_path")
        if lut_path:
            filters.append(LUTGrading(lut_path, strength=config.get("lut_strength", 0.3)))

        # Film grain last (adds texture after all other processing)
        grain = config.get("film_grain", 0)
        if grain > 0:
            filters.append(FilmGrain(intensity=grain))

        return cls(filters)

    def apply(self, image: Image.Image, seed: int | None = None) -> tuple:
        """Apply all filters in sequence.

        Returns (result_image, timings_dict).
        """
        timings = {}
        for f in self.filters:
            t0 = time.time()
            if isinstance(f, FilmGrain):
                image = f.apply(image, seed=seed)
            else:
                image = f.apply(image)
            timings[f.name] = time.time() - t0
        return image, timings

    def has_filters(self) -> bool:
        return len(self.filters) > 0
