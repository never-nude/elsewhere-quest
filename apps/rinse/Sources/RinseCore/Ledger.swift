import Foundation

/// A running record of what has been washed, for the lifetime total and the streak.
public struct Ledger: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let date: Date
        public let bytes: Int64
        public let count: Int
    }

    public private(set) var entries: [Entry] = []

    public init() {}

    public var totalBytes: Int64 { entries.reduce(0) { $0 + $1.bytes } }
    public var lastWash: Date? { entries.last?.date }

    public mutating func record(bytes: Int64, count: Int, at date: Date) {
        guard count > 0 else { return }
        entries.append(Entry(date: date, bytes: bytes, count: count))
    }

    /// Days in a row with a wash, counting back from today (or from yesterday, if today is still open).
    public func streak(asOf now: Date, calendar: Calendar = .current) -> Int {
        let days = Set(entries.map { calendar.startOfDay(for: $0.date) })
        var day = calendar.startOfDay(for: now)
        if !days.contains(day) {
            guard let yesterday = calendar.date(byAdding: .day, value: -1, to: day) else { return 0 }
            day = yesterday
        }
        var count = 0
        while days.contains(day) {
            count += 1
            guard let previous = calendar.date(byAdding: .day, value: -1, to: day) else { break }
            day = previous
        }
        return count
    }

    public static func load(from url: URL) -> Ledger {
        guard let data = try? Data(contentsOf: url),
              let ledger = try? JSONDecoder().decode(Ledger.self, from: data) else { return Ledger() }
        return ledger
    }

    public func save(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }
}

public enum ByteFormat {
    /// Decimal units, as Finder shows them: "3.4 GB", "512 MB", "0 KB".
    public static func string(_ bytes: Int64) -> String {
        let value = Double(max(0, bytes))
        if value >= 1e12 { return trimmed(value / 1e12) + " TB" }
        if value >= 1e9 { return trimmed(value / 1e9) + " GB" }
        if value >= 1e6 { return String(Int((value / 1e6).rounded())) + " MB" }
        return String(Int((value / 1e3).rounded())) + " KB"
    }

    private static func trimmed(_ value: Double) -> String {
        if value >= 99.95 { return String(Int(value.rounded())) }
        let rounded = (value * 10).rounded() / 10
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }
}
