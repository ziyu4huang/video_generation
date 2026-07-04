//
//  MacTTS.swift
//  LTXVideoDirector
//
//  Native (no ffmpeg, no Python) narration synthesis via macOS's built-in
//  `say` command — the native-relay counterpart to
//  app/commands/video-relay.py's `_generate_tts_say` (that file's
//  `edge-tts` neural-TTS engine option isn't ported: it's an external
//  Python package/network dependency, out of scope for a native port whose
//  whole point is fewer moving parts, not more). `say` writes AIFF, which
//  AVFoundation/VideoConcatenator.replaceAudioTrack already reads natively
//  — no format conversion step needed, unlike the Python version's
//  AIFF->AAC ffmpeg re-encode.
//

import Foundation

public enum MacTTS {
    public enum TTSError: Error, CustomStringConvertible {
        case sayFailed(String)

        public var description: String {
            switch self {
            case .sayFailed(let reason):
                return "MacTTS: 'say' failed — \(reason). List available voices with: say -v '?'"
            }
        }
    }

    /// Synthesizes `text` to an AIFF file at `outputURL` using macOS's `say`.
    /// `voice` defaults to "Meijia" (zh-TW) and `rate` to 145 words/min,
    /// matching the Python version's own defaults.
    public static func synthesize(text: String, voice: String = "Meijia", rate: Int = 145, to outputURL: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        process.arguments = ["-v", voice, "-r", String(rate), "-o", outputURL.path, text]

        let stderrPipe = Pipe()
        process.standardError = stderrPipe

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""
            throw TTSError.sayFailed("voice '\(voice)' may not be installed. stderr: \(stderr)")
        }
    }
}
