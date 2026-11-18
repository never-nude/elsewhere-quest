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
    /// Categories the owner switched off.
    public var disabled: Set<Residue> = []
    /// Paths the owner said never to show again.
    public var ignored: Set<String> = []

    public init() {}
}
