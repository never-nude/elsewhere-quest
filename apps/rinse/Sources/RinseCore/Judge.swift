import Foundation

/// What Rinse recommends doing with one item.
public enum Verdict: String, Codable, CaseIterable, Sendable, Identifiable {
    /// Send it to the Trash: it is replaceable and nobody is using it.
    case wash
    /// Move it to the filing folder: it is yours, but it is in the way.
    case file
    /// Do nothing for now.
    case leave

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .wash: return "Can go"
        case .file: return "File away"
        case .leave: return "Leave for now"
        }
    }

    public var blurb: String {
        switch self {
        case .wash: return "Replaceable and unused. These go to the Trash."
        case .file: return "Yours, but idle. These move to your filing folder, sorted by kind and month."
        case .leave: return "Too recent, too small, or not safe to guess about."
        }
    }

    /// SF Symbol name.
    public var symbol: String {
        switch self {
        case .wash: return "drop.fill"
        case .file: return "archivebox.fill"
        case .leave: return "pause.circle"
        }
    }
}

/// Whether a file has ever been opened, when the system can tell.
public struct Usage: Equatable, Sendable {
    /// Nil means it has never been opened.
    public let lastOpened: Date?
    public init(lastOpened: Date?) { self.lastOpened = lastOpened }
}

/// The recommendation for one item, with the number and the reasons behind it.
public struct Assessment: Hashable, Sendable {
    public let verdict: Verdict
    /// 0 to 100: how sure the rules are of the verdict.
    public let confidence: Int
    public let reasons: [String]

    public init(verdict: Verdict, confidence: Int, reasons: [String]) {
        self.verdict = verdict
        self.confidence = confidence
        self.reasons = reasons
    }
}

/// Turns what is known about an item into a recommendation.
///
/// Two measures decide it. **Replaceability**: could you get this again without effort
/// (a cache rebuilds, an installer downloads again, a document you wrote does not)?
/// **Dormancy**: how long has it sat untouched, against the limit for its kind?
/// Dormant and replaceable can go. Dormant and yours gets filed. Anything not yet dormant is left.
public enum Judge {
    /// What "dormant" is measured against.
    public enum Limit: Sendable {
        case age(days: Int)
        case size(bytes: Int64)
    }

    public struct Evidence: Sendable {
        public var kind: Residue
        public var name: String
        public var isDirectory: Bool
        public var bytes: Int64
        /// Days since anything touched it.
        public var idleDays: Int
        public var limit: Limit
        /// True when macOS recorded where it was downloaded from.
        public var hasOrigin: Bool
        /// Nil when the system cannot say whether it was ever opened.
        public var usage: Usage?
        /// True when the filing folder is on another disk, so filing gives space back.
        public var filingFreesSpace: Bool
        /// True for a screen capture that no longer has the name macOS gave it: someone chose to keep it.
        public var renamed = false
        /// False for tool folders that may hold more than a cache (models, logins).
        public var regenerable = true

        public init(kind: Residue, name: String, isDirectory: Bool = false, bytes: Int64 = 0, idleDays: Int,
                    limit: Limit, hasOrigin: Bool = false, usage: Usage? = nil, filingFreesSpace: Bool = false) {
            self.kind = kind
            self.name = name
            self.isDirectory = isDirectory
            self.bytes = bytes
            self.idleDays = idleDays
            self.limit = limit
            self.hasOrigin = hasOrigin
            self.usage = usage
            self.filingFreesSpace = filingFreesSpace
        }
    }

    /// At or above this, an item counts as replaceable.
    static let replaceableLine = 0.6
    /// At or above this, an item counts as dormant. It is reached exactly at the limit for its kind.
    static let dormantLine = 0.5

    static let disposable: Set<String> = [
        "dmg", "pkg", "mpkg", "xip", "iso", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
        "app", "torrent", "crdownload", "download", "part", "ics",
    ]
    static let documents: Set<String> = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "txt", "rtf",
        "md", "csv", "epub", "psd", "ai", "sketch", "fig", "blend", "obj", "stl", "usdz",
    ]
    static let media: Set<String> = [
        "png", "jpg", "jpeg", "heic", "gif", "tiff", "raw", "dng", "svg", "webp",
        "mov", "mp4", "m4v", "mkv", "avi", "mp3", "wav", "aiff", "m4a", "flac",
    ]

    public static func assess(_ e: Evidence) -> Assessment {
        if e.kind == .caches || e.kind == .developer, !e.regenerable {
            return Assessment(verdict: .leave, confidence: 50,
                              reasons: ["tool data that may not come back, check before removing"])
        }
        var (replaceable, reasons) = replaceability(e)
        let dormant = dormancy(e)

        guard dormant >= dormantLine else {
            let why: String
            switch e.limit {
            case .age: why = "still recent"
            case .size: why = "small"
            }
            return Assessment(verdict: .leave, confidence: percent(1 - dormant), reasons: reasons + [why])
        }
        if replaceable >= replaceableLine {
            return Assessment(verdict: .wash, confidence: percent(0.55 * replaceable + 0.45 * dormant), reasons: reasons)
        }
        // A big file that already sits in its place gains nothing from moving across the same disk.
        if e.kind == .bigIdle, !e.filingFreesSpace {
            reasons.append("filing it would only help on another disk")
            return Assessment(verdict: .leave, confidence: 50, reasons: reasons)
        }
        return Assessment(verdict: .file, confidence: percent(0.55 * (1 - replaceable) + 0.45 * dormant), reasons: reasons)
    }

    /// 0 (only you have this) to 1 (it will come back by itself).
    static func replaceability(_ e: Evidence) -> (Double, [String]) {
        switch e.kind {
        case .caches, .developer:
            return (1, ["rebuilds itself"])
        case .installers:
            // Without a download record it may be a disk image the owner made, so it is never washed.
            guard e.hasOrigin else { return (0.45, ["no download record, so it may be your own"]) }
            return (0.95, ["an installer", "can be downloaded again"])
        case .screenshots, .recordings:
            if e.renamed { return (0.3, ["you renamed it"]) }
            let isShot = e.kind == .screenshots
            guard let usage = e.usage else { return (isShot ? 0.7 : 0.5, []) }
            if usage.lastOpened == nil { return (isShot ? 0.75 : 0.65, ["never opened"]) }
            return (isShot ? 0.35 : 0.3, ["you have opened it"])
        case .staleDownloads, .bigIdle:
            if e.isDirectory { return (0.2, ["a folder of your files"]) }
            var score = 0.4
            var reasons: [String] = []
            let ext = Scanner.fileExtension(e.name)
            if disposable.contains(ext) {
                score = 0.85
                reasons.append("an archive or installer")
            } else if documents.contains(ext) {
                score = 0.25
                reasons.append("a document")
            } else if media.contains(ext) {
                score = 0.25
                reasons.append("a photo, video or sound file")
            }
            if e.hasOrigin {
                score += 0.1
                reasons.append("can be downloaded again")
            }
            if let usage = e.usage, usage.lastOpened == nil {
                score += 0.1
                reasons.append("never opened")
            }
            return (min(score, 1), reasons)
        }
    }

    /// 0 (just touched, or tiny) to 1 (long forgotten, or huge). Exactly 0.5 at the limit.
    static func dormancy(_ e: Evidence) -> Double {
        switch e.limit {
        case .age(let days):
            let idle = Double(max(0, e.idleDays)), limit = Double(max(0, days))
            if idle < limit { return 0.5 * idle / limit }
            return 0.5 + 0.5 * min(1, (idle - limit) / (3 * limit + 7))
        case .size(let bytes):
            let size = Double(max(0, e.bytes)), limit = Double(max(1, bytes))
            if size < limit { return 0.5 * size / limit }
            return 0.5 + 0.5 * min(1, (size - limit) / (9 * limit))
        }
    }

    private static func percent(_ value: Double) -> Int {
        Int((max(0, min(1, value)) * 100).rounded())
    }
}
