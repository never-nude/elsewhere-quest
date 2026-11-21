import Foundation

/// The thresholds that decide what is listed and what is pre-checked.
public struct Rules: Codable, Equatable, Sendable {
    /// Screenshots older than this are pre-checked.
    public var screenshotDays = 7
    /// Screen recordings older than this are pre-checked.
    public var recordingDays = 7
    /// Installers older than this are pre-checked.
    public var installerDays = 3
    /// Xcode build folders untouched for this long are pre-checked.
    public var buildDays = 7
    /// Device support folders untouched for this long are pre-checked.
    public var deviceSupportDays = 90
    /// Downloads untouched for this long are listed (never pre-checked).
    public var staleDownloadDays = 30
    /// Files at least this big and idle for `bigFileIdleDays` are listed (never pre-checked).
    public var bigFileBytes: Int64 = 250_000_000
    public var bigFileIdleDays = 60
    /// Caches at least this big are pre-checked.
    public var cacheSuggestBytes: Int64 = 100_000_000
    /// Caches smaller than this are not worth a row.
    public var cacheListBytes: Int64 = 5_000_000
    /// Projects untouched for this long can give up their dependency and build folders.
    public var projectIdleDays = 14
    /// Empty folders and empty files untouched for this long can go.
    public var emptyDays = 7
    /// Categories the owner switched off.
    public var disabled: Set<Residue> = []
    /// Paths the owner said never to show again.
    public var ignored: Set<String> = []

    public init() {}

    /// Settings saved by an earlier version may lack newer keys; those keep their defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func value<T: Decodable>(_ key: CodingKeys, _ fallback: T) throws -> T {
            try c.decodeIfPresent(T.self, forKey: key) ?? fallback
        }
        let d = Rules()
        screenshotDays = try value(.screenshotDays, d.screenshotDays)
        recordingDays = try value(.recordingDays, d.recordingDays)
        installerDays = try value(.installerDays, d.installerDays)
        buildDays = try value(.buildDays, d.buildDays)
        deviceSupportDays = try value(.deviceSupportDays, d.deviceSupportDays)
        staleDownloadDays = try value(.staleDownloadDays, d.staleDownloadDays)
        bigFileBytes = try value(.bigFileBytes, d.bigFileBytes)
        bigFileIdleDays = try value(.bigFileIdleDays, d.bigFileIdleDays)
        cacheSuggestBytes = try value(.cacheSuggestBytes, d.cacheSuggestBytes)
        cacheListBytes = try value(.cacheListBytes, d.cacheListBytes)
        projectIdleDays = try value(.projectIdleDays, d.projectIdleDays)
        emptyDays = try value(.emptyDays, d.emptyDays)
        // A category name this version does not know is dropped rather than losing every setting.
        let names = try value(.disabled, [String]())
        disabled = Set(names.compactMap(Residue.init(rawValue:)))
        ignored = try value(.ignored, d.ignored)
    }
}
