"""CPU-pure unit tests for app/commands/image-storyboard.py.

Covers the ``--kontext-lock`` routing logic — the decision of which shots take
the true in-context Kontext path vs the soft seed+Flux2KleinEdit ref-cond lock
vs independent T2I. No pipeline, no mflux, no GPU; the end-to-end Kontext arc is
exercised by the certify run (`scripts/kontext-identity-certify.py`), not here.
"""
import argparse
import importlib
from types import SimpleNamespace

# Hyphen in the module filename prevents a normal import; mirror image.py's
# importlib.import_module path used for every app/commands/image-* module.
sb = importlib.import_module("app.commands.image-storyboard")

from app.planning.scene_spec import SceneSpec  # noqa: E402


def _shot(character_id):
    return SceneSpec(id=f"c-{character_id}", subject="x", scene="x",
                     character_id=character_id)


def _args(kontext_lock, hero):
    ns = argparse.Namespace()
    ns.kontext_lock = kontext_lock
    return SimpleNamespace(kontext_lock=kontext_lock), hero


# --- _kontext_lock_active ---------------------------------------------------

def test_kontext_lock_active_requires_both_flag_and_hero():
    args_on, hero = _args(True, "hero.png")
    assert sb._kontext_lock_active(args_on, hero) is True


def test_kontext_lock_inactive_without_flag():
    args_off, hero = _args(False, "hero.png")
    assert sb._kontext_lock_active(args_off, hero) is False


def test_kontext_lock_inactive_without_hero():
    # No hero → Kontext has no conditioning image → fall back to the soft lock.
    args_on, _ = _args(True, None)
    assert sb._kontext_lock_active(args_on, None) is False


def test_kontext_lock_inactive_missing_attr():
    # A namespace without the attribute (older callers) must not crash.
    assert sb._kontext_lock_active(SimpleNamespace(), "hero.png") is False


# --- _shot_route ------------------------------------------------------------

def test_shot_route_recurring_with_kontext_lock():
    route = sb._shot_route(_shot("detective"), ["detective"], kontext_lock=True)
    assert route == "kontext"


def test_shot_route_recurring_without_kontext_lock_is_soft():
    # Default: the certified soft seed+Flux2KleinEdit ref-cond lock.
    route = sb._shot_route(_shot("detective"), ["detective"], kontext_lock=False)
    assert route == "locked"


def test_shot_route_non_recurring_is_independent():
    # A character that appears once, or no character at all, is plain T2I.
    assert sb._shot_route(_shot("extra"), ["detective"], kontext_lock=True) == "independent"
    assert sb._shot_route(_shot(None), [], kontext_lock=True) == "independent"


def test_shot_route_recurring_character_only_locks_when_in_recurring_set():
    # character_id set but NOT recurring (appears in one shot) → independent.
    route = sb._shot_route(_shot("detective"), [], kontext_lock=True)
    assert route == "independent"


# --- end-to-end routing over a fixture arc ---------------------------------

def test_routing_splits_an_arc_into_kontext_and_independent():
    """The deterministic fixture: one recurring detective across 3 beats.

    With --kontext-lock: all 3 detective shots defer to the single Kontext
    batch; without it they take the soft lock. Non-recurring shots are always
    independent regardless of the flag.
    """
    arc = [_shot("detective") for _ in range(3)] + [_shot("bystander")]

    routes_on = [sb._shot_route(s, ["detective"], kontext_lock=True) for s in arc]
    assert routes_on == ["kontext", "kontext", "kontext", "independent"]

    routes_off = [sb._shot_route(s, ["detective"], kontext_lock=False) for s in arc]
    assert routes_off == ["locked", "locked", "locked", "independent"]
