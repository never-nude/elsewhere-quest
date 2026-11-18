import Foundation

/// One file or folder Rinse thinks could go.
public struct Finding: Identifiable, Hashable, Sendable {
    /// The absolute path.
    public var id: String { url.path }
    public let url: URL
    public let name: String
    public let category: Residue
    /// Space it takes on disk, folders included in full.
    public let bytes: Int64
    public let lastTouched: Date
    public let isDirectory: Bool
    /// True when the rules are confident enough to pre-check it.
    public let suggested: Bool
    /// A short human reason, such as "12 days old".
    public let reason: String

    public init(url: URL, name: String, category: Residue, bytes: Int64, lastTouched: Date,
                isDirectory: Bool, suggested: Bool, reason: String) {
        self.url = url
        self.name = name
        self.category = category
        self.bytes = bytes
        self.lastTouched = lastTouched
        self.isDirectory = isDirectory
        self.suggested = suggested
        self.reason = reason
    }
}

public struct ScanResult: Sendable {
    public let findings: [Finding]
    public let scannedAt: Date

    public init(findings: [Finding], scannedAt: Date) {
        self.findings = findings
        self.scannedAt = scannedAt
    }

    public var totalBytes: Int64 { findings.reduce(0) { $0 + $1.bytes } }
    public var suggestedBytes: Int64 { findings.filter(\.suggested).reduce(0) { $0 + $1.bytes } }

    /// Categories that have at least one finding, in display order.
    public var categories: [Residue] {
        let present = Set(findings.map(\.category))
        return Residue.allCases.filter(present.contains)
    }

    /// Findings of one category, biggest first.
    public func findings(in category: Residue) -> [Finding] {
        findings.filter { $0.category == category }.sorted { $0.bytes > $1.bytes }
    }

    public func bytes(in category: Residue) -> Int64 {
        findings.filter { $0.category == category }.reduce(0) { $0 + $1.bytes }
    }
}
