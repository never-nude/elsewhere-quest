import AppKit
import Observation
import RinseCore

/// Things about the app itself, as opposed to the rules for what counts as residue.
struct Prefs: Codable, Equatable {
    var ritualEnabled = true
    var ritualHour = 21
    var ritualMinute = 30
    var showSizeInMenuBar = true
}

enum Phase: Equatable {
    case review, washing, clean
}

/// How much of a category is checked.
enum Mark {
    case none, some, all
}

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    var result: ScanResult?
    var isScanning = false
    var phase: Phase = .review
    var lastReport: WashReport?
    var rules: Rules
    var prefs: Prefs
    var ledger: Ledger
    var showSettings = false

    /// Where the owner disagreed with the rules: path to checked or not.
    private var overrides: [String: Bool] = [:]
    @ObservationIgnored private var rescanQueued = false
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private let home = FileManager.default.homeDirectoryForCurrentUser
    private static let ledgerURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Rinse/ledger.json")

    private init() {
        rules = Self.load(Rules.self, key: "rules") ?? Rules()
        prefs = Self.load(Prefs.self, key: "prefs") ?? Prefs()
        ledger = Ledger.load(from: Self.ledgerURL)
    }

    // MARK: - Lifecycle

    func start() {
        guard timer == nil else { return }
        Notifier.shared.onOpen = { [weak self] in self?.openReview() }
        Notifier.shared.prepare()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.tick() }
        }
        Task { await scan() }
    }

    /// Runs once a minute: the evening reminder, and an hourly look to keep the menu bar honest.
    private func tick() async {
        let now = Date()
        if prefs.ritualEnabled, ritualIsDue(now) {
            defaults.set(Self.dayKey(now), forKey: "lastRitualDay")
            await scan()
            if selectedBytes > 0 { Notifier.shared.announce(bytes: selectedBytes) }
        } else if !ReviewWindow.shared.isVisible,
                  now.timeIntervalSince(result?.scannedAt ?? .distantPast) > 3600 {
            await scan()
        }
    }

    private func ritualIsDue(_ now: Date) -> Bool {
        guard defaults.string(forKey: "lastRitualDay") != Self.dayKey(now),
              let due = Calendar.current.date(bySettingHour: prefs.ritualHour, minute: prefs.ritualMinute,
                                              second: 0, of: now) else { return false }
        return now >= due
    }

    private static func dayKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    }

    // MARK: - Scanning

    func scan() async {
        if isScanning {
            rescanQueued = true
            return
        }
        isScanning = true
        repeat {
            rescanQueued = false
            let scanner = Scanner(
                locations: Locations(home: home, screenshotFolder: Platform.screenshotFolder()),
                rules: rules, now: Date())
            result = await Task.detached(priority: .utility) { scanner.scan() }.value
        } while rescanQueued
        isScanning = false
    }

    // MARK: - Selection

    var selectedFindings: [Finding] { (result?.findings ?? []).filter(isSelected) }
    var selectedBytes: Int64 { selectedFindings.reduce(0) { $0 + $1.bytes } }
    var hasResidue: Bool { selectedBytes > 0 }

    func isSelected(_ finding: Finding) -> Bool { overrides[finding.id] ?? finding.suggested }

    func setSelected(_ finding: Finding, _ on: Bool) { overrides[finding.id] = on }

    func mark(for category: Residue) -> Mark {
        let all = result?.findings(in: category) ?? []
        let checked = all.filter(isSelected).count
        return checked == 0 ? .none : checked == all.count ? .all : .some
    }

    /// Clicking a category's box checks everything, unless everything already is.
    func toggle(_ category: Residue) {
        let on = mark(for: category) != .all
        for finding in result?.findings(in: category) ?? [] { overrides[finding.id] = on }
    }

    /// "Never show this again."
    func ignore(_ finding: Finding) {
        rules.ignored.insert(finding.id)
        overrides[finding.id] = nil
        if let current = result {
            result = ScanResult(findings: current.findings.filter { $0.id != finding.id }, scannedAt: current.scannedAt)
        }
        saveSettings()
    }

    // MARK: - Washing

    func wash() async {
        let chosen = selectedFindings
        guard !chosen.isEmpty, phase != .washing else { return }
        phase = .washing
        let home = self.home
        let report = await Task.detached(priority: .userInitiated) {
            Washer.wash(chosen, home: home, trasher: SystemTrasher())
        }.value
        ledger.record(bytes: report.bytes, count: report.washed.count, at: Date())
        try? ledger.save(to: Self.ledgerURL)
        for finding in chosen { overrides[finding.id] = nil }
        lastReport = report
        phase = .clean
        await scan()
    }

    func finishWash() {
        phase = .review
        lastReport = nil
    }

    // MARK: - Windows

    func openReview(settings: Bool = false) {
        if phase == .clean { finishWash() }
        showSettings = settings
        ReviewWindow.shared.show(model: self)
    }

    // MARK: - Persistence

    func saveSettings() {
        Self.store(rules, key: "rules")
        Self.store(prefs, key: "prefs")
    }

    private static func load<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func store<T: Encodable>(_ value: T, key: String) {
        if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) }
    }
}
