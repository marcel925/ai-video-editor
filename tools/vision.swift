// Apple Vision helpers for thumbnail.py (macOS only). Compiled on first use
// into the venv's bin/ folder - nothing here runs on Linux, where
// thumbnail.py falls back to OpenCV and skips cut-outs.
//
//   vision faces <image>...          one JSON line per image: the faces found,
//                                    each with its box (0-1, top-left origin)
//                                    and Vision's capture quality (0-1: sharp,
//                                    lit, eyes open, facing the camera)
//   vision cutout <in> <out.png>     the foreground subject (the speaker) on a
//                                    transparent background, at full size
import AppKit
import CoreImage
import Foundation
import Vision

func cgImage(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func faces(_ path: String) -> [String: Any] {
    guard let img = cgImage(path) else { return ["file": path, "error": "unreadable"] }
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    let quality = VNDetectFaceCaptureQualityRequest()
    let landmarks = VNDetectFaceLandmarksRequest()
    do { try handler.perform([quality, landmarks]) } catch { return ["file": path, "error": "\(error)"] }
    // Vision's boxes are normalised with a bottom-left origin; flip to top-left
    let found: [[String: Any]] = (quality.results ?? []).map { f in
        let b = f.boundingBox
        var face: [String: Any] = [
            "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height,
            "quality": Double(f.faceCaptureQuality ?? 0),
        ]
        if let yaw = f.yaw?.doubleValue { face["yaw"] = yaw }
        // mouth opening relative to face height: talking vs a closed-mouth smile
        if let lm = (landmarks.results ?? []).first(where: { $0.boundingBox.intersects(b) })?.landmarks,
           let inner = lm.innerLips?.normalizedPoints, !inner.isEmpty {
            let ys = inner.map { $0.y }
            face["mouth_open"] = Double((ys.max()! - ys.min()!))
        }
        return face
    }
    return ["file": path, "width": img.width, "height": img.height, "faces": found]
}

/// Share of the mask that is subject (8-bit mask).
func coverage(_ buf: CVPixelBuffer) -> Double {
    CVPixelBufferLockBaseAddress(buf, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
    let w = CVPixelBufferGetWidth(buf), h = CVPixelBufferGetHeight(buf), row = CVPixelBufferGetBytesPerRow(buf)
    guard let base = CVPixelBufferGetBaseAddress(buf)?.assumingMemoryBound(to: UInt8.self) else { return 0 }
    var on = 0
    for y in stride(from: 0, to: h, by: 4) { for x in stride(from: 0, to: w, by: 4) where base[y * row + x] > 127 { on += 1 } }
    return Double(on) / Double(max(1, (w / 4) * (h / 4)))
}

func cutout(_ input: String, _ output: String) {
    guard let img = cgImage(input) else { fail("cannot read \(input)") }
    let handler = VNImageRequestHandler(cgImage: img, options: [:])
    var mask: CVPixelBuffer?
    // Person segmentation first: it is trained on people and keeps hair and
    // hands while dropping the chair behind them. The generic subject mask is
    // the fallback for a frame with no person in it (a screen, a product).
    let person = VNGeneratePersonSegmentationRequest()
    person.qualityLevel = .accurate
    person.outputPixelFormat = kCVPixelFormatType_OneComponent8
    try? handler.perform([person])
    if let r = person.results?.first, coverage(r.pixelBuffer) > 0.01 {
        mask = r.pixelBuffer
    } else if #available(macOS 14.0, *) {
        let req = VNGenerateForegroundInstanceMaskRequest()
        try? handler.perform([req])
        if let r = req.results?.first {
            mask = try? r.generateScaledMaskForImage(forInstances: r.allInstances, from: handler)
        }
    }
    guard let m = mask else { fail("no subject found in \(input)") }
    let ci = CIImage(cgImage: img)
    var maskImg = CIImage(cvPixelBuffer: m)
    // the person-segmentation mask comes out smaller than the image
    maskImg = maskImg.transformed(by: CGAffineTransform(
        scaleX: ci.extent.width / maskImg.extent.width, y: ci.extent.height / maskImg.extent.height))
    let clear = CIImage(color: .clear).cropped(to: ci.extent)
    guard let blend = CIFilter(name: "CIBlendWithMask", parameters: [
        kCIInputImageKey: ci, kCIInputBackgroundImageKey: clear, kCIInputMaskImageKey: maskImg,
    ])?.outputImage else { fail("mask blend failed") }
    let ctx = CIContext()
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { fail("no sRGB") }
    do {
        try ctx.writePNGRepresentation(of: blend, to: URL(fileURLWithPath: output), format: .RGBA8, colorSpace: space)
    } catch { fail("cannot write \(output): \(error)") }
}

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: vision faces <image>... | vision cutout <in> <out.png>") }
switch args[1] {
case "faces":
    for path in args[2...] {
        let data = try! JSONSerialization.data(withJSONObject: faces(path), options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
    }
case "cutout":
    guard args.count == 4 else { fail("usage: vision cutout <in> <out.png>") }
    cutout(args[2], args[3])
default:
    fail("unknown command \(args[1])")
}
