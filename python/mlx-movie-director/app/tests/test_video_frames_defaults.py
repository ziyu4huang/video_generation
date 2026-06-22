"""Unit tests for video frame-alignment + self-test default application.

Covers the iter-7 manual fixes (workflow kept re-flagging these as medium
findings but would not auto-fix them):
- video-relay._adjust_frames now enforces the min-9 clamp on the aligned
  branch, matching video-generate._adjust_frames (parity / no drift).
- video-generate._apply_prompt_defaults is the magic-number-compare helper
  that replaces the broken `is None` self-test default loop.
"""
import importlib
import types


def _relay():
    return importlib.import_module("app.commands.video-relay")


def _generate():
    return importlib.import_module("app.commands.video-generate")


class TestAdjustFramesClamp:
    def test_aligned_below_9_clamped_to_9(self):
        # frames=1 satisfies (frames-1)%8==0 but must still return >=9.
        assert _relay()._adjust_frames(1) == 9

    def test_aligned_9_stays_9(self):
        assert _relay()._adjust_frames(9) == 9

    def test_aligned_17_stays_17(self):
        assert _relay()._adjust_frames(17) == 17

    def test_unaligned_adjusted_and_clamped(self):
        # frames=5: (5-1)%8=4 != 0 -> k=round(4/8)=0 -> max(9, 8*0+1)=9
        assert _relay()._adjust_frames(5) == 9

    def test_relay_matches_generate_no_drift(self):
        relay, gen = _relay(), _generate()
        for f in (1, 2, 5, 9, 10, 17, 25, 33, 97):
            assert relay._adjust_frames(f) == gen._adjust_frames(f), f"drift at frames={f}"


class TestApplyPromptDefaults:
    def _args(self, **kw):
        base = dict(
            frames=97, width=704, height=448, fps=24.0,
            cfg_scale=None, stg_scale=None, stage1_steps=None, stage2_steps=None,
        )
        base.update(kw)
        return types.SimpleNamespace(**base)

    def test_applies_when_at_argparse_default(self):
        args = self._args()  # frames=97 == argparse default -> rec applies
        _generate()._apply_prompt_defaults(args, {"frames": 41, "width": 768})
        assert args.frames == 41
        assert args.width == 768

    def test_skips_when_user_overrode(self):
        args = self._args(frames=50)  # user explicitly set 50 -> rec NOT applied
        _generate()._apply_prompt_defaults(args, {"frames": 41})
        assert args.frames == 50

    def test_cfg_scale_none_default_applied(self):
        # cfg_scale argparse default is None (NOT a magic number) -> rec applies
        args = self._args()
        _generate()._apply_prompt_defaults(args, {"cfg_scale": 3.0})
        assert args.cfg_scale == 3.0

    def test_keys_outside_argparse_defaults_ignored(self):
        args = self._args()
        _generate()._apply_prompt_defaults(args, {"bogus_key": 999})
        assert not hasattr(args, "bogus_key")
