// swift-tools-version:5.9
import PackageDescription

// RinseCore is plain Foundation, so its rules and tests also run on Linux.
// The app itself (SwiftUI, menu bar) only exists on macOS.
var products: [Product] = [.library(name: "RinseCore", targets: ["RinseCore"])]
var targets: [Target] = [
    .target(name: "RinseCore"),
    .testTarget(name: "RinseCoreTests", dependencies: ["RinseCore"]),
]

#if os(macOS)
products.append(.executable(name: "Wash", targets: ["Wash"]))
targets.append(.executableTarget(name: "Wash", dependencies: ["RinseCore"], path: "Sources/Rinse"))
#endif

let package = Package(
    name: "Wash",
    platforms: [.macOS(.v14)],
    products: products,
    targets: targets
)
