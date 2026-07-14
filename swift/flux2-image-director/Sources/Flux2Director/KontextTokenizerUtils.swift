//
//  KontextTokenizerUtils.swift
//  Flux2Director
//
//  Shared byte-level BPE utility (GPT-2's `bytes_to_unicode`) used by both
//  `KontextCLIPTokenizer` and (indirectly, for reference) `Flux2Tokenizer`.
//  Kept as a free function rather than duplicating `Flux2Tokenizer`'s
//  private copy — the two tokenizers otherwise implement genuinely
//  different BPE conventions (Ġ-space-prefix vs `</w>`-suffix), only this
//  one primitive is truly shared.
//

import Foundation

enum KontextTokenizerUtils {
    static func bytesToUnicode() -> [UInt8: Character] {
        let directRanges: [Range<Int>] = [33..<127, 161..<173, 174..<256]
        var bs: Set<UInt8> = []
        for range in directRanges { for v in range { bs.insert(UInt8(v)) } }
        var encoder: [UInt8: Character] = [:]
        var other: UInt16 = 0
        for byte in 0..<256 {
            let v = UInt8(byte)
            if bs.contains(v) {
                encoder[v] = Character(UnicodeScalar(byte)!)
            } else {
                encoder[v] = Character(UnicodeScalar(256 + Int(other))!)
                other += 1
            }
        }
        return encoder
    }
}
