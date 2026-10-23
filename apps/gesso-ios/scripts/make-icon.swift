// macOS helper: qlmanage renders the existing SVG, then flatten to an opaque App Store icon.
import AppKit
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
      let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 1024 * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("Expected input and output paths") }
context.setFillColor(CGColor(red: 0.047, green: 0.043, blue: 0.039, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
context.interpolationQuality = .high
context.draw(source, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not write icon") }
