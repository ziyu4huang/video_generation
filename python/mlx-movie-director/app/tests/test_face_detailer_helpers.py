"""Unit tests for pure-Python helpers in app/face_detailer.py — no mediapipe needed."""

import numpy as np
import pytest
from PIL import Image

from app.face_detailer import BoundingBox, create_feathered_mask, expand_bbox


class TestExpandBbox:
    def _box(self, x1, y1, x2, y2) -> BoundingBox:
        return BoundingBox(x1=x1, y1=y1, x2=x2, y2=y2)

    def test_expand_increases_size(self):
        box = self._box(40, 40, 60, 60)  # 20×20
        expanded = expand_bbox(box, padding=2.0, img_w=200, img_h=200)
        w = expanded.x2 - expanded.x1
        h = expanded.y2 - expanded.y1
        assert w > 20
        assert h > 20

    def test_expand_stays_within_image(self):
        box = self._box(5, 5, 15, 15)  # near top-left corner
        expanded = expand_bbox(box, padding=5.0, img_w=100, img_h=100)
        assert expanded.x1 >= 0
        assert expanded.y1 >= 0
        assert expanded.x2 <= 100
        assert expanded.y2 <= 100

    def test_expand_near_edge_clamps(self):
        box = self._box(90, 90, 98, 98)  # near bottom-right
        expanded = expand_bbox(box, padding=3.0, img_w=100, img_h=100)
        assert expanded.x2 <= 100
        assert expanded.y2 <= 100

    def test_output_dimensions_are_even(self):
        # VAE requires even dimensions
        box = self._box(10, 10, 51, 53)  # odd initial size
        expanded = expand_bbox(box, padding=1.0, img_w=200, img_h=200)
        w = expanded.x2 - expanded.x1
        h = expanded.y2 - expanded.y1
        assert w % 2 == 0, f"Width {w} must be even"
        assert h % 2 == 0, f"Height {h} must be even"

    def test_center_preserved_approximately(self):
        box = self._box(40, 40, 60, 60)  # center at (50, 50)
        expanded = expand_bbox(box, padding=1.5, img_w=200, img_h=200)
        cx = (expanded.x1 + expanded.x2) / 2
        cy = (expanded.y1 + expanded.y2) / 2
        assert abs(cx - 50) <= 2, f"Center X {cx} drifted too far from 50"
        assert abs(cy - 50) <= 2, f"Center Y {cy} drifted too far from 50"

    def test_padding_one_is_identity(self):
        box = self._box(30, 30, 70, 70)
        expanded = expand_bbox(box, padding=1.0, img_w=200, img_h=200)
        assert expanded.x1 >= 30 - 1
        assert expanded.y1 >= 30 - 1
        assert expanded.x2 <= 70 + 1
        assert expanded.y2 <= 70 + 1


class TestCreateFeatheredMask:
    def test_returns_grayscale_image(self):
        mask = create_feathered_mask(64, 64)
        assert mask.mode == "L"

    def test_output_size_correct(self):
        mask = create_feathered_mask(80, 60, feather=10)
        assert mask.size == (80, 60)

    def test_center_is_max_value(self):
        mask = create_feathered_mask(64, 64, feather=8)
        arr = np.array(mask)
        center = arr[30:34, 30:34]
        assert center.max() == 255

    def test_edges_are_lower_than_center(self):
        mask = create_feathered_mask(64, 64, feather=16)
        arr = np.array(mask)
        center_val = arr[30, 30]
        edge_top = arr[0, 32]
        edge_left = arr[32, 0]
        assert edge_top < center_val, "Top edge should be darker than center"
        assert edge_left < center_val, "Left edge should be darker than center"

    def test_zero_feather_all_max(self):
        mask = create_feathered_mask(32, 32, feather=0)
        arr = np.array(mask)
        assert arr.min() == 255, "Zero feather: all pixels should be 255"

    def test_values_in_valid_range(self):
        mask = create_feathered_mask(64, 64, feather=12)
        arr = np.array(mask)
        assert arr.min() >= 0
        assert arr.max() <= 255

    def test_feather_gradient_monotonic_from_edge(self):
        feather = 16
        mask = create_feathered_mask(64, 64, feather=feather)
        arr = np.array(mask, dtype=float)
        # Check top edge: values should increase going inward
        col = arr[:feather, 32]  # center column, top rows
        for i in range(len(col) - 1):
            assert col[i] <= col[i + 1], f"Mask not monotonic at row {i}"
