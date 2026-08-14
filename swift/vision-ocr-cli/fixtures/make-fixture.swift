// One-shot fixture generator — run from swift/vision-ocr-cli/:
//   swift fixtures/make-fixture.swift
// Writes fixtures/hello-123.png (800x200, black "HELLO 123" on white).
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let w = 800, h = 200
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
    space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 96, nil)
let attrs: [NSAttributedString.Key: Any] = [kCTFontAttributeName as NSAttributedString.Key: font]
let line = CTLineCreateWithAttributedString(
    NSAttributedString(string: "HELLO 123", attributes: attrs))
let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
ctx.textPosition = CGPoint(
    x: (CGFloat(w) - bounds.width) / 2, y: (CGFloat(h) - bounds.height) / 2)
CTLineDraw(line, ctx)
let image = ctx.makeImage()!
let url = URL(fileURLWithPath: "fixtures/hello-123.png")
let dest = CGImageDestinationCreateWithURL(
    url as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("wrote fixtures/hello-123.png")
