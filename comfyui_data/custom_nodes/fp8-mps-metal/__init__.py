"""
fp8-mps-metal: FP8 MPS 支援，透過 Metal GPU 著色器加速 Apple Silicon 上的 FP8 運算。

修補內容：
1. comfy_kitchen.scaled_mm_v2.scaled_mm_v2 → Metal GPU FP8 matmul（關鍵修補）
2. torch._scaled_mm → Metal GPU FP8 matmul（舊版相容）
3. comfy_kitchen.quantize_per_tensor_fp8 → MPS 上改為 CPU 量化後以 uint8 傳回
4. comfy_kitchen.dequantize_per_tensor_fp8 → MPS uint8 input 先移至 CPU 做反量化再移回 MPS

根本問題：
  comfy_kitchen 使用 torch.nn.functional.scaled_mm (v2 API) →
  torch._scaled_mm_v2，而非舊的 torch._scaled_mm。
  mat_a(uint8) + mat_b(float8_e4m3fn) 均不符合 v2 API 要求，丟出 ValueError。
  _handle_fp8_linear 的 except 子句只抓 RuntimeError/TypeError，故 fallback 失效。
  解法：在 scaled_mm_v2 層攔截，改用 Metal GPU kernel。
"""
import os
import sys
import torch
import logging

logger = logging.getLogger("fp8-mps-metal")

_NODE_DIR = os.path.dirname(os.path.abspath(__file__))
if _NODE_DIR not in sys.path:
    sys.path.insert(0, _NODE_DIR)


def _fp8_to_uint8_mps(tensor: torch.Tensor, dev) -> torch.Tensor:
    """
    將 float8_e4m3fn / float8_e5m2 / uint8 tensor 轉成 MPS 上的 uint8。
    位元模式不變，只換 dtype 標籤（uint8 = MPS 上合法的 FP8 替代儲存格式）。
    """
    if tensor.dtype == torch.uint8:
        return tensor.to(dev) if tensor.device.type != 'mps' else tensor
    # float8：view 成 uint8（相同位元）→ 移至 MPS
    cpu_t = tensor.cpu()
    return cpu_t.view(torch.uint8).to(dev)


def _patch_scaled_mm_v2():
    """
    主要修補：comfy_kitchen.scaled_mm_v2.scaled_mm_v2

    comfy_kitchen 使用此函數做 FP8 matmul，最終呼叫 torch._scaled_mm_v2。
    在 MPS 上 float8/uint8 dtype 無法通過 v2 API 的 dtype 驗證（ValueError）。
    此修補攔截 MPS 裝置的呼叫，改用 Metal GPU kernel。
    """
    try:
        import comfy_kitchen.scaled_mm_v2 as ck_smm
    except ImportError:
        logger.warning("[fp8-mps-metal] 找不到 comfy_kitchen.scaled_mm_v2，跳過 scaled_mm patch")
        return

    _orig_smm_v2 = ck_smm.scaled_mm_v2

    def _mps_scaled_mm_v2(input, weight, scale_a, scale_b,
                          bias=None, out_dtype=None, **kwargs):
        """
        攔截 MPS + FP8/uint8 的 scaled matmul 呼叫。

        參數（同 comfy_kitchen 慣例）：
          input  : (M, K) — activation，uint8 或 float8
          weight : (K, N) — 已轉置的 weight，uint8 或 float8
          scale_a: per-tensor 或 per-row scale（scalar 或 1D tensor）
          scale_b: per-tensor 或 per-row scale（scalar 或 1D tensor）
        """
        is_mps = input.device.type == 'mps'
        is_fp8_or_u8 = input.dtype in (torch.uint8, torch.float8_e4m3fn, torch.float8_e5m2)

        if not (is_mps and is_fp8_or_u8):
            return _orig_smm_v2(input, weight, scale_a, scale_b,
                                bias=bias, out_dtype=out_dtype, **kwargs)

        dev = input.device

        # 統一轉為 MPS uint8
        A_u8 = _fp8_to_uint8_mps(input, dev).contiguous()
        # weight 在 scaled_mm 是 (K, N)；Metal kernel 要 B = (N, K)
        W_u8 = _fp8_to_uint8_mps(weight, dev)
        B_u8 = W_u8.t().contiguous()  # (N, K)

        try:
            import fp8_mps_native

            # scale 確保為 1D 以上的 MPS float32 tensor
            def to_scale(s):
                if isinstance(s, torch.Tensor):
                    t = s.float().to(dev)
                    return t.unsqueeze(0) if t.ndim == 0 else t
                return torch.tensor([float(s)], dtype=torch.float32, device=dev)

            sa = to_scale(scale_a)
            sb = to_scale(scale_b)

            result = fp8_mps_native.fp8_scaled_mm_auto(A_u8, B_u8, sa, sb)

            if bias is not None:
                result = result + bias.to(result.device)
            if out_dtype is not None:
                result = result.to(out_dtype)
            return result

        except Exception as e:
            logger.debug(f"[fp8-mps-metal] Metal scaled_mm 失敗，改用 CPU fallback：{e}")

        # CPU fallback：uint8 view 成 float8 → 原始函數（在 CPU 上執行）
        try:
            A_cpu_fp8 = A_u8.cpu().view(torch.float8_e4m3fn)
            W_cpu_u8 = W_u8.cpu() if W_u8.device.type == 'mps' else W_u8
            if W_cpu_u8.dtype == torch.uint8:
                W_cpu_fp8 = W_cpu_u8.view(torch.float8_e4m3fn)
            else:
                W_cpu_fp8 = W_cpu_u8
            sa_cpu = scale_a.cpu() if isinstance(scale_a, torch.Tensor) else scale_a
            sb_cpu = scale_b.cpu() if isinstance(scale_b, torch.Tensor) else scale_b
            bias_cpu = bias.cpu() if bias is not None else None
            result_cpu = _orig_smm_v2(A_cpu_fp8, W_cpu_fp8, sa_cpu, sb_cpu,
                                      bias=bias_cpu, out_dtype=out_dtype, **kwargs)
            return result_cpu.to(dev)
        except Exception as e2:
            logger.error(f"[fp8-mps-metal] CPU fallback 也失敗：{e2}")
            raise

    ck_smm.scaled_mm_v2 = _mps_scaled_mm_v2

    # Also patch the local import in comfy_kitchen.tensor.fp8
    # fp8.py does `from comfy_kitchen.scaled_mm_v2 import scaled_mm_v2` at module load,
    # creating a local name binding that bypasses the module-level patch above.
    try:
        import comfy_kitchen.tensor.fp8 as ck_fp8
        ck_fp8.scaled_mm_v2 = _mps_scaled_mm_v2
        logger.info("[fp8-mps-metal] comfy_kitchen.tensor.fp8.scaled_mm_v2 也已 patch（修復 import binding）")
    except ImportError:
        pass

    logger.info("[fp8-mps-metal] comfy_kitchen.scaled_mm_v2 已 patch → MPS Metal GPU + CPU fallback")


def _patch_scaled_mm_legacy():
    """
    舊版修補：torch._scaled_mm（相容舊版 comfy_kitchen）。
    """
    try:
        import fp8_mps_patch
        fp8_mps_patch.install()
        logger.info("[fp8-mps-metal] torch._scaled_mm 已 patch → Metal GPU（舊版相容）")
    except Exception as e:
        logger.warning(f"[fp8-mps-metal] torch._scaled_mm patch 失敗（非關鍵）：{e}")


def _patch_comfy_kitchen():
    """
    Patch comfy_kitchen 頂層 fp8 量化/反量化函數，支援 MPS uint8 儲存格式。

    comfy_kitchen 的 quantize/dequantize_per_tensor_fp8 底層走
    torch.ops.comfy_kitchen（custom op），其 eager backend 拒絕 uint8 dtype。
    因此在頂層攔截：MPS uint8 tensor 先移至 CPU 以正確 fp8 dtype 操作，再移回 MPS。
    """
    try:
        import comfy_kitchen as comfy_k
    except ImportError:
        logger.warning("[fp8-mps-metal] 找不到 comfy_kitchen，跳過 patch")
        return

    _orig_quant = comfy_k.quantize_per_tensor_fp8
    _orig_dequant = comfy_k.dequantize_per_tensor_fp8

    def _quant_fp8_mps(x: torch.Tensor, scale,
                       output_type: torch.dtype = torch.float8_e4m3fn) -> torch.Tensor:
        """MPS 上繞過 float8 dtype 限制：在 CPU 量化後 view 成 uint8 再移至 MPS。"""
        if x.device.type == 'mps' and output_type in (torch.float8_e4m3fn, torch.float8_e5m2):
            dev = x.device
            scale_cpu = scale.cpu() if isinstance(scale, torch.Tensor) else scale
            result_fp8 = _orig_quant(x.cpu(), scale_cpu, output_type)
            return result_fp8.view(torch.uint8).to(dev)
        return _orig_quant(x, scale, output_type)

    def _dequant_fp8_mps(x: torch.Tensor, scale,
                         output_type: torch.dtype = torch.bfloat16) -> torch.Tensor:
        """
        MPS uint8/float8（FP8 bit pattern）→ Metal GPU dequant（優先）→ CPU roundtrip（備援）。
        """
        is_mps = x.device.type == 'mps'
        is_fp8 = x.dtype in (torch.uint8, torch.float8_e4m3fn, torch.float8_e5m2)
        if is_mps and is_fp8:
            # Normalize float8 → uint8 view on MPS
            if x.dtype != torch.uint8:
                x = x.cpu().view(torch.uint8).to(x.device)
            dev = x.device
            scale_cpu = scale.cpu() if isinstance(scale, torch.Tensor) else scale

            try:
                import fp8_mps_native
                scale_mps = (scale.float().to(dev) if isinstance(scale, torch.Tensor)
                             else torch.tensor([float(scale)], dtype=torch.float32, device=dev))
                result = fp8_mps_native.fp8_dequantize(x.contiguous().view(-1), scale_mps)
                return result.view(x.shape).to(output_type)
            except Exception as e:
                logger.debug(f"[fp8-mps-metal] Metal dequant 失敗，改用 CPU roundtrip：{e}")

            x_fp8_cpu = x.cpu().view(torch.float8_e4m3fn)
            result = _orig_dequant(x_fp8_cpu, scale_cpu, output_type)
            return result.to(dev)
        return _orig_dequant(x, scale, output_type)

    # --- Patch stochastic_rounding_fp8 for MPS ---
    # Used during LoRA weight patching: re-quantizes bf16 → fp8.
    # Original does sign.to(float8_e4m3fn) which MPS rejects.
    _orig_sr = comfy_k.stochastic_rounding_fp8

    def _sr_fp8_mps(x: torch.Tensor, rng: torch.Tensor,
                    output_type: torch.dtype = torch.float8_e4m3fn) -> torch.Tensor:
        if x.device.type == 'mps' and output_type in (torch.float8_e4m3fn, torch.float8_e5m2):
            dev = x.device
            rng_cpu = rng.cpu() if rng.device.type == 'mps' else rng
            result = _orig_sr(x.cpu(), rng_cpu, output_type)
            # Store as uint8 on MPS (same bit pattern as fp8)
            return result.view(torch.uint8).to(dev)
        return _orig_sr(x, rng, output_type)

    comfy_k.quantize_per_tensor_fp8 = _quant_fp8_mps
    comfy_k.dequantize_per_tensor_fp8 = _dequant_fp8_mps
    comfy_k.stochastic_rounding_fp8 = _sr_fp8_mps

    # Also patch comfy.float local binding (same import-binding issue as scaled_mm_v2)
    try:
        import comfy.float as cf
        cf._ck_stochastic_rounding_fp8 = _sr_fp8_mps
        logger.info("[fp8-mps-metal] comfy.float._ck_stochastic_rounding_fp8 也已 patch")
    except (ImportError, AttributeError):
        pass

    logger.info("[fp8-mps-metal] comfy_kitchen 頂層 FP8 量化/反量化/stochastic_rounding 已 patch（MPS uint8 模式）")


# --- 啟動時執行（順序重要）---
_patch_scaled_mm_v2()    # 主要修補：攔截 scaled_mm_v2（comfy_kitchen 現用版本）
_patch_scaled_mm_legacy()  # 舊版修補：torch._scaled_mm（相容性）
_patch_comfy_kitchen()   # 量化/反量化修補

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
