"""DEPRECATED: use 'run.py image review lora --self-test zit-sda-v1' instead.

This module is kept as a stub so that any remaining imports don't break.
The SDA LoKr A/B test has been migrated to the unified review lora pattern.

Migration guide:
  OLD: run.py image sda-test --prompt "..." --seeds 42,123,777,999
  NEW: run.py image review lora --self-test zit-sda-v1
       run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7
"""

import sys


def add_sda_test_args(parser):
    """No-op: args registered by review module's add_review_args() instead."""
    pass


def run_sda_test(args):
    """Print deprecation message and exit."""
    print("DEPRECATED: 'image sda-test' has been replaced by 'image review lora'", file=sys.stderr)
    print("", file=sys.stderr)
    print("  OLD: run.py image sda-test --prompt '...' --seeds 42,123,777,999", file=sys.stderr)
    print("  NEW: run.py image review lora --self-test zit-sda-v1", file=sys.stderr)
    print("       run.py image review lora --self-test zit-sda-v1 --seeds 42,123 --lora-scale 0.7", file=sys.stderr)
    print("", file=sys.stderr)
    print("  Also available as a unified self-test:", file=sys.stderr)
    print("       run.py image --self-test zit-sda-v1", file=sys.stderr)
    print("       run.py image --self-test sda", file=sys.stderr)
    sys.exit(1)
