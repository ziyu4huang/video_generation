//
//  BasicAVTransformerBlock.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.transformer.
//  BasicAVTransformerBlock — the joint audio+video transformer block that
//  gets stacked 48x into the full LTX-2.3 DiT. Each block: video
//  self-attn -> audio self-attn -> video text cross-attn -> audio text
//  cross-attn -> bidirectional audio<->video cross-modal attn -> video FF
//  -> audio FF, each modulated by AdaLN scale/shift/gate parameters.
//
//  NOT YET PORTED: STG perturbation masking (BatchedPerturbationConfig —
//  used for spatial-temporal guidance during inference, not needed for a
//  basic forward pass). All `perturbations` branches in the reference are
//  omitted here; this block always takes the un-perturbed path.
//

import MLX

public struct BasicAVTransformerBlock {
    public let attn1: Attention           // video self-attention
    public let audioAttn1: Attention      // audio self-attention
    public let attn2: Attention           // video text cross-attention
    public let audioAttn2: Attention      // audio text cross-attention
    public let audioToVideoAttn: Attention
    public let videoToAudioAttn: Attention
    public let ff: FeedForward
    public let audioFF: FeedForward

    public let scaleShiftTable: MLXArray            // (9, videoDim)
    public let audioScaleShiftTable: MLXArray        // (9, audioDim)
    public let promptScaleShiftTable: MLXArray       // (2, videoDim)
    public let audioPromptScaleShiftTable: MLXArray  // (2, audioDim)
    public let scaleShiftTableA2VCAVideo: MLXArray   // (5, videoDim)
    public let scaleShiftTableA2VCAAudio: MLXArray   // (5, audioDim)
    public let normEps: Float

    public init(
        attn1: Attention, audioAttn1: Attention, attn2: Attention, audioAttn2: Attention,
        audioToVideoAttn: Attention, videoToAudioAttn: Attention,
        ff: FeedForward, audioFF: FeedForward,
        scaleShiftTable: MLXArray, audioScaleShiftTable: MLXArray,
        promptScaleShiftTable: MLXArray, audioPromptScaleShiftTable: MLXArray,
        scaleShiftTableA2VCAVideo: MLXArray, scaleShiftTableA2VCAAudio: MLXArray,
        normEps: Float = 1e-6
    ) {
        self.attn1 = attn1; self.audioAttn1 = audioAttn1
        self.attn2 = attn2; self.audioAttn2 = audioAttn2
        self.audioToVideoAttn = audioToVideoAttn; self.videoToAudioAttn = videoToAudioAttn
        self.ff = ff; self.audioFF = audioFF
        self.scaleShiftTable = scaleShiftTable; self.audioScaleShiftTable = audioScaleShiftTable
        self.promptScaleShiftTable = promptScaleShiftTable; self.audioPromptScaleShiftTable = audioPromptScaleShiftTable
        self.scaleShiftTableA2VCAVideo = scaleShiftTableA2VCAVideo; self.scaleShiftTableA2VCAAudio = scaleShiftTableA2VCAAudio
        self.normEps = normEps
    }

    private func rmsNorm(_ x: MLXArray) -> MLXArray {
        // Affine-free RMS norm (no learnable weight) — same formula as
        // PixelNorm.apply but kept separate: this one uses the transformer's
        // norm_eps, not the VAE's fixed 1e-8.
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + normEps)
    }

    /// Unpack AdaLN parameters and add the block's scale_shift_table.
    /// Handles both scalar (B, P*dim) and per-token (B, N, P*dim) inputs.
    /// Returns P arrays, each broadcastable with (B, N, dim).
    private func unpackAdaLN(_ params: MLXArray, table: MLXArray, numParams: Int, dim: Int) -> [MLXArray] {
        if params.ndim == 2 {
            let b = params.dim(0)
            var p = params.reshaped([b, numParams, dim])
            p = p + table[0..<numParams, 0...].expandedDimensions(axis: 0)
            return (0..<numParams).map { p[0..., $0, 0...].expandedDimensions(axis: 1) }
        } else {
            let b = params.dim(0), n = params.dim(1)
            var p = params.reshaped([b, n, numParams, dim])
            p = p + table[0..<numParams, 0...].expandedDimensions(axis: 0).expandedDimensions(axis: 0)
            return (0..<numParams).map { p[0..., 0..., $0, 0...] }
        }
    }

    public func callAsFunction(
        videoHidden: MLXArray, audioHidden: MLXArray,
        videoAdaLNParams: MLXArray, audioAdaLNParams: MLXArray,
        videoPromptAdaLNParams: MLXArray, audioPromptAdaLNParams: MLXArray,
        avCAVideoParams: MLXArray, avCAAudioParams: MLXArray,
        avCAA2VGateParams: MLXArray, avCAV2AGateParams: MLXArray,
        videoTextEmbeds: MLXArray? = nil, audioTextEmbeds: MLXArray? = nil,
        videoRopeFreqs: RoPE.Freqs? = nil, audioRopeFreqs: RoPE.Freqs? = nil,
        videoCrossRopeFreqs: RoPE.Freqs? = nil, audioCrossRopeFreqs: RoPE.Freqs? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil
    ) -> (video: MLXArray, audio: MLXArray) {
        var video = videoHidden
        var audio = audioHidden
        let vdim = video.dim(-1)
        let adim = audio.dim(-1)

        let vParams = unpackAdaLN(videoAdaLNParams, table: scaleShiftTable, numParams: 9, dim: vdim)
        let (vShiftSA, vScaleSA, vGateSA, vShiftFF, vScaleFF, vGateFF, vShiftCA, vScaleCA, vGateCA) =
            (vParams[0], vParams[1], vParams[2], vParams[3], vParams[4], vParams[5], vParams[6], vParams[7], vParams[8])

        let aParams = unpackAdaLN(audioAdaLNParams, table: audioScaleShiftTable, numParams: 9, dim: adim)
        let (aShiftSA, aScaleSA, aGateSA, aShiftFF, aScaleFF, aGateFF, aShiftCA, aScaleCA, aGateCA) =
            (aParams[0], aParams[1], aParams[2], aParams[3], aParams[4], aParams[5], aParams[6], aParams[7], aParams[8])

        let avVParams = unpackAdaLN(avCAVideoParams, table: scaleShiftTableA2VCAVideo, numParams: 4, dim: vdim)
        let (avVScaleA2V, avVShiftA2V, avVScaleV2A, avVShiftV2A) = (avVParams[0], avVParams[1], avVParams[2], avVParams[3])
        let avVGateA2V: MLXArray = {
            let gateRow = scaleShiftTableA2VCAVideo[4, 0...]
            if avCAA2VGateParams.ndim == 2 {
                return (avCAA2VGateParams + gateRow.expandedDimensions(axis: 0)).expandedDimensions(axis: 1)
            } else {
                return avCAA2VGateParams + gateRow.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
            }
        }()

        let avAParams = unpackAdaLN(avCAAudioParams, table: scaleShiftTableA2VCAAudio, numParams: 4, dim: adim)
        let (avAScaleA2V, avAShiftA2V, avAScaleV2A, avAShiftV2A) = (avAParams[0], avAParams[1], avAParams[2], avAParams[3])
        let avAGateV2A: MLXArray = {
            let gateRow = scaleShiftTableA2VCAAudio[4, 0...]
            if avCAV2AGateParams.ndim == 2 {
                return (avCAV2AGateParams + gateRow.expandedDimensions(axis: 0)).expandedDimensions(axis: 1)
            } else {
                return avCAV2AGateParams + gateRow.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
            }
        }()

        // 1. Video self-attention
        var videoNormed = rmsNorm(video) * (1.0 + vScaleSA) + vShiftSA
        let videoSAOut = attn1(videoNormed, ropeFreqs: videoRopeFreqs, attentionMask: videoAttentionMask)
        video = video + videoSAOut * vGateSA

        // 2. Audio self-attention
        var audioNormed = rmsNorm(audio) * (1.0 + aScaleSA) + aShiftSA
        let audioSAOut = audioAttn1(audioNormed, ropeFreqs: audioRopeFreqs, attentionMask: audioAttentionMask)
        audio = audio + audioSAOut * aGateSA

        // 3. Video text cross-attention
        if let videoTextEmbeds {
            videoNormed = rmsNorm(video) * (1.0 + vScaleCA) + vShiftCA
            let vp = unpackAdaLN(videoPromptAdaLNParams, table: promptScaleShiftTable, numParams: 2, dim: vdim)
            let textScaled = videoTextEmbeds * (1.0 + vp[1]) + vp[0]
            video = video + attn2(videoNormed, encoderHiddenStates: textScaled) * vGateCA
        }

        // 4. Audio text cross-attention
        if let audioTextEmbeds {
            audioNormed = rmsNorm(audio) * (1.0 + aScaleCA) + aShiftCA
            let ap = unpackAdaLN(audioPromptAdaLNParams, table: audioPromptScaleShiftTable, numParams: 2, dim: adim)
            let textScaled = audioTextEmbeds * (1.0 + ap[1]) + ap[0]
            audio = audio + audioAttn2(audioNormed, encoderHiddenStates: textScaled) * aGateCA
        }

        // 5-6. Audio-video cross-modal attention (norm both ONCE, shared by A2V and V2A)
        let videoNorm3 = rmsNorm(video)
        let audioNorm3 = rmsNorm(audio)

        let videoQA2V = videoNorm3 * (1.0 + avVScaleA2V) + avVShiftA2V
        let audioKVA2V = audioNorm3 * (1.0 + avAScaleA2V) + avAShiftA2V
        let a2vOut = audioToVideoAttn(
            videoQA2V, encoderHiddenStates: audioKVA2V,
            ropeFreqs: videoCrossRopeFreqs, ropeFreqsK: audioCrossRopeFreqs
        ) * avVGateA2V
        video = video + a2vOut

        let audioQV2A = audioNorm3 * (1.0 + avAScaleV2A) + avAShiftV2A
        let videoKVV2A = videoNorm3 * (1.0 + avVScaleV2A) + avVShiftV2A
        let v2aOut = videoToAudioAttn(
            audioQV2A, encoderHiddenStates: videoKVV2A,
            ropeFreqs: audioCrossRopeFreqs, ropeFreqsK: videoCrossRopeFreqs
        ) * avAGateV2A
        audio = audio + v2aOut

        // 7. Video feed-forward
        videoNormed = rmsNorm(video) * (1.0 + vScaleFF) + vShiftFF
        video = video + ff(videoNormed) * vGateFF

        // 8. Audio feed-forward
        audioNormed = rmsNorm(audio) * (1.0 + aScaleFF) + aShiftFF
        audio = audio + audioFF(audioNormed) * aGateFF

        return (video, audio)
    }
}
