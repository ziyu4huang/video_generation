//
//  LinearResampler.swift
//  LTXVideoDirector
//
//  Arbitrary-ratio audio resampler for the audio-track injection path
//  (--audio-track): user WAVs can arrive at any sample rate, but
//  AudioProcessor.waveformToMel expects 16kHz. HannSincResampler.swift
//  (already ported) only handles fixed-integer upsampling (used by
//  VocoderWithBWE for 16kHz->48kHz); it doesn't cover the general
//  downsample-to-16kHz case needed here.
//
//  This is plain linear interpolation, NOT a proper polyphase/windowed-sinc
//  anti-aliased resampler — adequate for preserving speech/dialogue
//  intelligibility in a dubbed track, but will alias somewhat on
//  high-frequency content when downsampling. Documented gap, same
//  "honest limitation" convention as NativeUpscaleStage's no-refine-pass
//  note — a proper anti-aliased resampler is a bounded follow-up if audio
//  quality complaints arise, not attempted here to keep this port scoped.
//

import Foundation

public enum LinearResampler {
    /// Resamples a single-channel signal from `fromRate` to `toRate` Hz via
    /// linear interpolation.
    public static func resample(_ signal: [Float], fromRate: Int, toRate: Int) -> [Float] {
        guard fromRate != toRate, !signal.isEmpty else { return signal }
        let ratio = Double(toRate) / Double(fromRate)
        let outCount = max(1, Int((Double(signal.count) * ratio).rounded()))
        var output = [Float](repeating: 0, count: outCount)
        let lastIndex = signal.count - 1
        for i in 0..<outCount {
            let srcPos = Double(i) / ratio
            let lo = min(lastIndex, Int(srcPos))
            let hi = min(lastIndex, lo + 1)
            let frac = Float(srcPos - Double(lo))
            output[i] = signal[lo] * (1 - frac) + signal[hi] * frac
        }
        return output
    }
}
