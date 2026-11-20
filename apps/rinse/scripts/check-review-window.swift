import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int(CommandLine.arguments[1]) else {
    fatalError("Expected the PID of the Wash process")
}

// Inspect our app's window bounds and PID without requiring access to its pixels or title.
for _ in 0..<15 {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let hasReview = windows.contains { window in
        guard window[kCGWindowOwnerPID as String] as? Int == pid,
              window[kCGWindowLayer as String] as? Int == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Double] else { return false }
        return (bounds["Width"] ?? 0) >= 620 && (bounds["Height"] ?? 0) >= 480
    }
    if hasReview {
        print("Wash review window is on screen")
        exit(EXIT_SUCCESS)
    }
    Thread.sleep(forTimeInterval: 1)
}

FileHandle.standardError.write(Data("Wash ran without an on-screen review window\n".utf8))
exit(EXIT_FAILURE)
