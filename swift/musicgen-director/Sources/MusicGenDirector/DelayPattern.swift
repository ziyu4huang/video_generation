//
//  DelayPattern.swift
//  MusicGenDirector
//
//  MusicGen's codebook-interleaving "delay pattern" — codebook c is offset
//  by c positions so autoregressive generation can predict all 4 codebooks'
//  next frame in lockstep. Ported from HF's modeling_musicgen.py
//  build_delay_pattern_mask/apply_delay_pattern_mask, specialized to the
//  mono (audio_channels=1) case (MusicGen-small has no stereo variant).
//
//  Derivation (confirmed against the exact worked example in HF's docstring,
//  num_codebooks=4, max_length=8 — see DelayPatternTests):
//    BOS-pad region:  t <= c
//    EOS-pad region:  t >= max_length - numCodebooks + 1 + c
//    valid (predict): c < t < max_length - numCodebooks + 1 + c
//    valid length per codebook = max_length - numCodebooks (constant)
//    => max_length = total_gen_len + numCodebooks
//    De-interleave: codebook c's clean frames = raw[c][(c+1)..<(c+1+total_gen_len)]
//

import Foundation

public enum DelayPattern {
    /// MusicGen-small's pad/bos token id (config.decoder.pad_token_id ==
    /// bos_token_id == 2048, one past the real vocab_size=2048 range).
    public static let padTokenId: Int32 = 2048

    /// Build the pattern mask for `numCodebooks` codebooks over `maxLength`
    /// raw steps. `mask[c][t] == -1` means "predict here"; any other value is
    /// the forced pad/bos token for that position.
    public static func buildMask(numCodebooks: Int, maxLength: Int) -> [[Int32]] {
        var mask = [[Int32]](repeating: [Int32](repeating: -1, count: maxLength), count: numCodebooks)
        for c in 0..<numCodebooks {
            for t in 0..<maxLength {
                let isBOSRegion = t <= c
                let isEOSRegion = t >= maxLength - numCodebooks + 1 + c
                if isBOSRegion || isEOSRegion {
                    mask[c][t] = padTokenId
                }
            }
        }
        return mask
    }

    /// Overwrite `raw[c][t]` with the pattern's forced value wherever the
    /// mask says so (mask != -1); leaves the model's real prediction in place
    /// at every "-1" position. Call after appending each new generated step.
    public static func apply(_ raw: inout [[Int32]], mask: [[Int32]]) {
        for c in 0..<raw.count {
            for t in 0..<raw[c].count {
                if mask[c][t] != -1 { raw[c][t] = mask[c][t] }
            }
        }
    }

    /// Strip the delay offset to recover clean, codebook-aligned frames ready
    /// for EnCodec decode. `frameCount` is `maxLength - numCodebooks`.
    public static func deinterleave(_ raw: [[Int32]], frameCount: Int) -> [[Int32]] {
        (0..<raw.count).map { c in Array(raw[c][(c + 1)..<(c + 1 + frameCount)]) }
    }
}
