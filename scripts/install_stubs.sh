#!/usr/bin/env bash
# Install Python stubs for packages unavailable on macOS/Apple Silicon.
# Called from run.sh with the venv path as $1.
set -e
VENV="${1:?Usage: install_stubs.sh <venv-path>}"
SITE="$("$VENV/bin/python" -c 'import site; print(site.getsitepackages()[0])')"

# ── triton stub ───────────────────────────────────────────────────────────────
# triton requires NVIDIA CUDA; this stub lets RMBG-SAM3 and torch._inductor
# load without errors.
mkdir -p "$SITE/triton"
cat > "$SITE/triton/__init__.py" << 'TRITON_STUB'
"""
Triton stub for macOS/Apple Silicon.
The real triton requires NVIDIA CUDA; these stubs let RMBG-SAM3 and
torch._inductor load without errors on platforms where triton is unavailable.
"""
import sys
import types


def _make_stub(name):
    mod = types.ModuleType(name)
    mod.__file__ = __file__
    mod.__path__ = []
    mod.__package__ = name
    sys.modules[name] = mod
    return mod


# ── triton.language ───────────────────────────────────────────────────────────

language = _make_stub("triton.language")


def _noop(*args, **kwargs):
    pass


class _DtypeStub:
    def __init__(self, name=""):
        self._name = name

    def __repr__(self):
        return f"triton.language.{self._name}"

    def __call__(self, *a, **kw):
        return self


class _TensorStub:
    pass


_TL_ATTRS = [
    "arange", "zeros", "zeros_like", "load", "store", "dot", "where",
    "exp", "log", "sqrt", "max", "min", "sum", "reduce",
    "atomic_add", "atomic_max", "atomic_min", "atomic_and", "atomic_or",
    "abs", "cast", "clamp", "sigmoid", "minimum", "ravel",
    "debug_barrier", "cdiv", "program_id",
    "TRITON_MAX_TENSOR_NUMEL",
]
for _attr in _TL_ATTRS:
    setattr(language, _attr, _noop)

language.constexpr = int
language.dtype = _DtypeStub()
language.tensor = _TensorStub

for _t in ("float32", "float16", "bfloat16", "float64",
           "int8", "int32", "int64", "uint8", "uint32", "uint64", "bool"):
    setattr(language, _t, _DtypeStub(_t))

language.float = _DtypeStub("float")
language.int = _DtypeStub("int")

_lang_core = _make_stub("triton.language.core")


def view(x, shape):
    pass


_lang_core.view = view
language.core = _lang_core

_lang_extra = _make_stub("triton.language.extra")
_lang_extra_cuda = _make_stub("triton.language.extra.cuda")
_lang_extra_cuda.libdevice = _noop
_lang_extra.cuda = _lang_extra_cuda
language.extra = _lang_extra

_lang_std = _make_stub("triton.language.standard")
_lang_std._log2 = _noop
language.standard = _lang_std
language.math = _make_stub("triton.language.math")


# ── triton.compiler ───────────────────────────────────────────────────────────

compiler = _make_stub("triton.compiler")


class CompiledKernel:
    pass


class AttrsDescriptor:
    pass


class ASTSource:
    pass


compiler.CompiledKernel = CompiledKernel
compiler.AttrsDescriptor = AttrsDescriptor
compiler.ASTSource = ASTSource

_compiler_inner = _make_stub("triton.compiler.compiler")
_compiler_inner.AttrsDescriptor = AttrsDescriptor
_compiler_inner.ASTSource = ASTSource
_compiler_inner.triton_key = _noop
compiler.compiler = _compiler_inner


# ── triton.backends ───────────────────────────────────────────────────────────

backends = _make_stub("triton.backends")
_backends_compiler = _make_stub("triton.backends.compiler")


class GPUTarget:
    def __init__(self, *a, **kw):
        pass


_backends_compiler.GPUTarget = GPUTarget
backends.compiler = _backends_compiler


# ── triton.runtime ────────────────────────────────────────────────────────────

runtime = _make_stub("triton.runtime")


class OutOfResources(Exception):
    pass


class PTXASError(Exception):
    pass


class IntelGPUError(Exception):
    pass


class JITFunction:
    pass


class KernelInterface:
    pass


_rt_autotuner = _make_stub("triton.runtime.autotuner")
_rt_autotuner.OutOfResources = OutOfResources
_rt_autotuner.PTXASError = PTXASError

_rt_jit = _make_stub("triton.runtime.jit")
_rt_jit.JITFunction = JITFunction
_rt_jit.KernelInterface = KernelInterface

_rt_cache = _make_stub("triton.runtime.cache")
_rt_cache.triton_key = _noop
_rt_cache._base64 = _noop
_rt_cache._base32 = _noop

_rt_errors = _make_stub("triton.runtime.errors")
_rt_errors.IntelGPUError = IntelGPUError

_make_stub("triton.runtime.driver")
_make_stub("triton.runtime.interpreter")

runtime.autotuner = _rt_autotuner
runtime.jit = _rt_jit
runtime.cache = _rt_cache
runtime.errors = _rt_errors


# ── triton top-level ──────────────────────────────────────────────────────────

def jit(fn=None, **kwargs):
    if fn is None:
        return lambda f: f
    return fn


def autotune(configs=None, key=None, **kwargs):
    return lambda fn: fn


def cdiv(a, b):
    return (a + b - 1) // b


class Config:
    def __init__(self, kwargs=None, num_warps=4, num_stages=2, **kw):
        pass


knobs = None
TRITON_STUB

# ── decord stub ───────────────────────────────────────────────────────────────
# decord has no wheel for macOS/Python 3.13; this stub lets RMBG-SAM3 load.
mkdir -p "$SITE/decord"
cat > "$SITE/decord/__init__.py" << 'DECORD_STUB'
"""
decord stub for macOS/Python 3.13.
Actual video decoding will raise NotImplementedError at runtime.
"""


class _Bridge:
    @staticmethod
    def set_bridge(name):
        pass


bridge = _Bridge()


def cpu(num_threads=0):
    return None


class VideoReader:
    def __init__(self, path, ctx=None, width=-1, height=-1, **kwargs):
        raise NotImplementedError(
            "decord.VideoReader is not available on this platform (macOS/Python 3.13). "
            "Video input via SAM3 is unsupported."
        )

    def __iter__(self):
        return iter([])

    def next(self):
        raise NotImplementedError("decord not available")

    def __len__(self):
        return 0
DECORD_STUB

echo "[stubs] triton and decord stubs installed to $SITE"
