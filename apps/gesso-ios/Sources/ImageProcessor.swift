import Foundation
import CoreImage
import CoreVideo
import ImageIO
import UniformTypeIdentifiers
import Vision

enum ImageProcessor {
    static func info(url: URL) throws -> [String: Any] {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let p = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = p[kCGImagePropertyPixelWidth] as? Int, let height = p[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { throw NativeError("unreadable", "Could not read this image.") }
        let orientation = p[kCGImagePropertyOrientation] as? UInt32 ?? 1
        let swapped = [5, 6, 7, 8].contains(orientation)
        let type = CGImageSourceGetType(source).map { $0 as String }
        // CIRAWFilter also accepts rendered images; initialization alone does not identify RAW.
        let raw = type.flatMap(UTType.init)?.conforms(to: .rawImage) == true || p[kCGImagePropertyDNGDictionary] != nil
        return ["natW": swapped ? height : width, "natH": swapped ? width : height, "raw": raw]
    }

    static func decode(url: URL, width: Int, height: Int) throws -> Data {
        guard (1...8192).contains(width), (1...8192).contains(height), width * height <= 24_500_000 else {
            throw NativeError("size", "Image dimensions exceed the working limit.")
        }
        let image: CIImage
        let properties = try info(url: url)
        if properties["raw"] as? Bool == true {
            guard let raw = CIRAWFilter(imageURL: url) else { throw NativeError("unreadable", "This RAW camera format is not supported.") }
            let size = raw.nativeSize
            if size.width > 0, size.height > 0 {
                // nativeSize ignores EXIF orientation; its longest side is orientation independent.
                raw.scaleFactor = Float(min(1, Double(max(width, height)) / max(size.width, size.height)))
            }
            guard let output = raw.outputImage else { throw NativeError("unreadable", "RAW development is unavailable for this photo.") }
            image = output
        } else {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: max(width, height),
                    kCGImageSourceShouldCacheImmediately: true
                  ] as CFDictionary) else { throw NativeError("unreadable", "Could not decode this photo.") }
            image = CIImage(cgImage: cg)
        }
        let extent = image.extent
        guard !extent.isEmpty, !extent.isInfinite, extent.width.isFinite, extent.height.isFinite else {
            throw NativeError("unreadable", "The image has invalid dimensions.")
        }
        let upright = image.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
            .transformed(by: CGAffineTransform(scaleX: Double(width) / extent.width, y: Double(height) / extent.height))
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CIContext(options: [.cacheIntermediates: false, .outputColorSpace: space])
        guard let cg = context.createCGImage(upright, from: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8, colorSpace: space) else {
            throw NativeError("memory", "Not enough memory to render this photo.")
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw NativeError("failed", "Could not create a PNG.")
        }
        // A fresh destination strips original metadata and bakes the orientation into pixels.
        CGImageDestinationAddImage(destination, cg, nil)
        guard CGImageDestinationFinalize(destination) else { throw NativeError("memory", "Could not finish the PNG.") }
        return data as Data
    }

    static func subject(url: URL, x: Double, y: Double, radius: Double) throws -> [String: Any] {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              cg.width <= 1024, cg.height <= 1024, x >= 0, y >= 0, x <= Double(cg.width), y <= Double(cg.height) else {
            throw NativeError("badArgs", "Subject analysis needs an upright image of at most 1024 pixels per side.")
        }
        let handler = VNImageRequestHandler(cgImage: cg, orientation: .up)
        let request = VNGenerateForegroundInstanceMaskRequest()
        do { try handler.perform([request]) }
        catch { throw NativeError("unsupported", "Subject detection is unavailable here. Loop around the subject instead.") }
        guard let observation = request.results?.first,
              let instance = instanceNear(observation.instanceMask, x: x / Double(cg.width), y: y / Double(cg.height),
                                          radius: radius / Double(max(cg.width, cg.height))) else { return ["found": false] }
        let mask = try observation.generateMask(forInstances: IndexSet(integer: instance))
        let binary = try threshold(mask)
        let contours = VNDetectContoursRequest()
        contours.contrastAdjustment = 1
        contours.detectsDarkOnLight = false
        contours.maximumImageDimension = 1024
        try VNImageRequestHandler(cgImage: binary, orientation: .up).perform([contours])
        let rings = try (contours.results?.first?.topLevelContours ?? []).compactMap { contour -> [Double]? in
            let simple = try contour.polygonApproximation(epsilon: 0.001)
            guard simple.pointCount >= 3 else { return nil }
            var ring: [Double] = []
            for i in 0..<simple.pointCount {
                let p = simple.normalizedPoints[i]
                ring.append(min(Double(cg.width), max(0, Double(p.x) * Double(cg.width))))
                ring.append(min(Double(cg.height), max(0, (1 - Double(p.y)) * Double(cg.height))))
            }
            return ring
        }.sorted { area($0) > area($1) }
        guard !rings.isEmpty else { return ["found": false] }
        return ["found": true, "w": cg.width, "h": cg.height, "polygons": rings]
    }

    private static func instanceNear(_ mask: CVPixelBuffer, x: Double, y: Double, radius: Double) -> Int? {
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(mask) else { return nil }
        let width = CVPixelBufferGetWidth(mask), height = CVPixelBufferGetHeight(mask)
        let stride = CVPixelBufferGetBytesPerRow(mask)
        let px = min(width - 1, max(0, Int(x * Double(width))))
        let py = min(height - 1, max(0, Int(y * Double(height))))
        let r = Int(ceil(radius * Double(max(width, height))))
        func label(_ ix: Int, _ iy: Int) -> Int {
            let row = base.advanced(by: iy * stride)
            switch CVPixelBufferGetPixelFormatType(mask) {
            case kCVPixelFormatType_OneComponent8: return Int(row.assumingMemoryBound(to: UInt8.self)[ix])
            case kCVPixelFormatType_OneComponent32Float: return Int(row.assumingMemoryBound(to: Float.self)[ix])
            default: return 0
            }
        }
        var best: (Int, Int)?
        for iy in max(0, py - r)...min(height - 1, py + r) {
            for ix in max(0, px - r)...min(width - 1, px + r) {
                let distance = (ix - px) * (ix - px) + (iy - py) * (iy - py)
                guard distance <= r * r else { continue }
                let value = label(ix, iy)
                if value > 0, best == nil || distance < best!.1 { best = (value, distance) }
            }
        }
        return best?.0
    }

    private static func threshold(_ buffer: CVPixelBuffer) throws -> CGImage {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw NativeError("failed", "Could not read the subject mask.") }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var pixels = Data(count: width * height)
        pixels.withUnsafeMutableBytes { bytes in
            let out = bytes.bindMemory(to: UInt8.self)
            for y in 0..<height {
                let row = base.advanced(by: y * stride).assumingMemoryBound(to: Float.self)
                for x in 0..<width { out[y * width + x] = row[x] >= 0.5 ? 255 : 0 }
            }
        }
        guard let provider = CGDataProvider(data: pixels as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0),
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw NativeError("failed", "Could not create the subject mask.")
        }
        return image
    }
    private static func area(_ ring: [Double]) -> Double {
        var result = 0.0
        for i in stride(from: 0, to: ring.count, by: 2) {
            let j = (i + 2) % ring.count
            result += ring[i] * ring[j + 1] - ring[j] * ring[i + 1]
        }
        return abs(result)
    }
}
