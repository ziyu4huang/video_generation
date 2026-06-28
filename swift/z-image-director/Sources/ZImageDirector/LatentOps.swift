//
//  LatentOps.swift
//  ZImageDirector
//
//  Phase 5: patchify (latent → tokens) and unpack (tokens → noise pred).
//  These are the reshape/transpose ops wrapping the transformer call.
//

import Foundation
import MLX

public enum LatentOps {

    /// Patchify: (1, C, H_lat, W_lat) → (1, N_img, C*4) tokens.
    /// Python: x.reshape(C,1,1,H_tok,2,W_tok,2).transpose(1,2,3,5,4,6,0).reshape(1,-1,C*4)
    public static func patchify(_ latent: MLXArray, hTok: Int, wTok: Int) -> MLXArray {
        let channels = latent.dim(1)  // 16
        // (C, 1, 1, H_tok, 2, W_tok, 2) then transpose (1,2,3,5,4,6,0)
        let reshaped = latent.reshaped([channels, 1, 1, hTok, 2, wTok, 2])
        let transposed = reshaped.transposed(1, 2, 3, 5, 4, 6, 0)
        return transposed.reshaped([1, -1, channels * 4])
    }

    /// Unpack: transformer out (1, N_img, C*4) → noise pred (1, C, H, W).
    /// Python: -out.reshape(1,1,H_tok,W_tok,2,2,C).transpose(6,0,1,2,4,3,5).reshape(1,C,H,W)
    public static func unpack(_ out: MLXArray, hTok: Int, wTok: Int, channels: Int) -> MLXArray {
        let reshaped = out.reshaped([1, 1, hTok, wTok, 2, 2, channels])
        let transposed = reshaped.transposed(6, 0, 1, 2, 4, 3, 5)
        return -(transposed.reshaped([1, channels, hTok * 2, wTok * 2]))
    }
}
