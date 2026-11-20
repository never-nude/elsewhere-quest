import Foundation

/// How a redundant item was shown to be redundant, so the same proof can be run again just before it moves.
public enum Proof: Hashable, Sendable {
    /// Not redundant, or nothing to re-prove beyond the kept copy existing.
    case none
    /// An archive (one file, or every piece of a split one) whose contents sit unpacked at `keeps`.
    /// `top` is the archive's single top-level name, which Finder may have renamed ("Wash.app" to "Wash 2.app").
    case unpacked(pieces: [String], top: String?)
    /// Byte for byte the same as `keeps`.
    case duplicate
    /// An older build of the app at `keeps`, which has this bundle identifier.
    case olderBuild(id: String)
    /// An installer for the app at `keeps`.
    case installer
}

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
    /// What Rinse recommends, how sure it is, and why.
    public let assessment: Assessment
    /// For a redundant item, the other copy that stays. It is checked again just before anything moves.
    public let keeps: URL?
    /// How that was proved.
    public let proof: Proof

    public var verdict: Verdict { assessment.verdict }
    /// A short human line, such as "Taken 12 days ago · never opened".
    public var reason: String { assessment.reasons.joined(separator: " · ") }

    public init(url: URL, name: String, category: Residue, bytes: Int64, lastTouched: Date,
                isDirectory: Bool, assessment: Assessment, keeps: URL? = nil, proof: Proof = .none) {
        self.url = url
        self.name = name
        self.category = category
        self.bytes = bytes
        self.lastTouched = lastTouched
        self.isDirectory = isDirectory
        self.assessment = assessment
        self.keeps = keeps
        self.proof = proof
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
    /// Space the recommended washes would give back.
    public var washBytes: Int64 { findings(recommended: .wash).reduce(0) { $0 + $1.bytes } }

    /// Findings Rinse recommends one thing for: surest first, then biggest.
    public func findings(recommended verdict: Verdict) -> [Finding] {
        findings.filter { $0.verdict == verdict }.sorted {
            ($0.assessment.confidence, $0.bytes) > ($1.assessment.confidence, $1.bytes)
        }
    }

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
