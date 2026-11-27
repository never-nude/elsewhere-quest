import AppKit
import Observation
import RinseCore

/// Things about the app itself, as opposed to the rules for what counts as residue.
struct Prefs: Codable, Equatable {
    var ritualEnabled = true
    var ritualHour = 21
    var ritualMinute = 30
    /// Show the amount ready to wash on the Dock icon and beside the menu bar drop.
    var showAmount = true
    var showMenuBarItem = true
    /// Where filed items go. Nil means "Filed Away" in Documents.
    var archivePath: String?

    init() {}

    /// Settings saved by an earlier version may lack newer keys; those keep their defaults.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ritualEnabled = try c.decodeIfPresent(Bool.self, forKey: .ritualEnabled) ?? ritualEnabled
        ritualHour = try c.decodeIfPresent(Int.self, forKey: .ritualHour) ?? ritualHour
        ritualMinute = try c.decodeIfPresent(Int.self, forKey: .ritualMinute) ?? ritualMinute
        showAmount = try c.decodeIfPresent(Bool.self, forKey: .showAmount) ?? showAmount
        showMenuBarItem = try c.decodeIfPresent(Bool.self, forKey: .showMenuBarItem) ?? showMenuBarItem
        archivePath = try c.decodeIfPresent(String.self, forKey: .archivePath)
    }
}

enum Phase: Equatable {
    case review, working, clean
}

/// What one rinse did.
struct RinseReport {
    let wash: WashReport
    let file: FileReport
    let archive: URL

    var failures: [WashReport.Failure] { wash.failures + file.failures }
    var didNothing: Bool { wash.washed.isEmpty && file.filed.isEmpty }
}

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    var result: ScanResult?
    var isScanning = false
    var phase: Phase = .review
    var lastReport: RinseReport?
    var rules: Rules
    var prefs: Prefs
    var ledger: Ledger
    var showSettings = false
    /// The row whose "why" card is open, from hovering or from the right-click menu.
    var explaining: String?

    // MARK: Storage

    /// Which part of the window is showing.
    var pane: Pane = .rinse
    enum Pane: String, CaseIterable, Identifiable {
        case rinse = "Rinse"
        case storage = "Storage"
        var id: String { rawValue }
    }

    private(set) var survey: Survey?
    private(set) var spaceHistory: SpaceHistory
    private(set) var isSurveying = false
    /// When a survey last started, finished or not, so one that cannot finish is not restarted every minute.
    @ObservationIgnored private var lastSurveyAttempt = Date.distantPast
    private(set) var snapshotDates: [Date] = []
    /// True while macOS has a software update downloaded and prepared but not installed.
    private(set) var updatePrepared = false
    private(set) var importantAvailable: Int64?
    private static let historyURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Rinse/space-history.json")

    /// What the owner chose, on top of the recommendations.
    private(set) var selection = Selection()
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
        spaceHistory = SpaceHistory.load(from: Self.historyURL)
    }

    /// Measures where the space is. Takes a while on a big home folder, so it runs in the background.
    func runSurvey() async {
        guard !isSurveying else { return }
        isSurveying = true
        lastSurveyAttempt = Date()
        let home = self.home
        let (fresh, snapshots, important) = await Task.detached(priority: .utility) {
            (Surveyor(home: home).survey(), Platform.localSnapshotListing(), Platform.availableForImportantUse())
        }.value
        survey = fresh
        snapshotDates = LocalSnapshots.dates(fromListing: snapshots)
        updatePrepared = LocalSnapshots.isPreparingUpdate(listing: snapshots)
        importantAvailable = important
        spaceHistory.record(fresh)
        try? spaceHistory.save(to: Self.historyURL)
        isSurveying = false
    }

    /// The newest earlier look to compare against, and what changed since. Prefers about a day ago,
    /// falls back to the oldest one there is.
    var growth: (since: Date, changes: [SpaceHistory.Change])? {
        guard let survey else { return nil }
        let past = spaceHistory.snapshot(olderThan: 20 * 3600, now: survey.measuredAt)
            ?? spaceHistory.snapshots.first { $0.date < survey.measuredAt.addingTimeInterval(-3600) }
        guard let past else { return nil }
        return (past.date, SpaceHistory.changes(from: past, to: survey))
    }

    func showStorage() {
        pane = .storage
        openReview()
        if !isSurveying, Date().timeIntervalSince(survey?.measuredAt ?? .distantPast) > 3600 {
            Task { await runSurvey() }
        }
    }

    /// Where filed items go: the chosen folder, or a "Filed Away" folder inside it when Rinse scans that place.
    var archive: URL {
        Locations.filingFolder(chosen: prefs.archivePath.map { URL(fileURLWithPath: $0) }, home: home,
                               screenshotFolder: Platform.screenshotFolder())
    }

    // MARK: - Lifecycle

    func start() {
        guard timer == nil else { return }
        Notifier.shared.onOpen = { [weak self] in self?.openReview() }
        Notifier.shared.prepare()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.tick() }
        }
        trackBadge()
        trackSettings()
        Task { await scan() }
    }

    /// Keeps the Dock badge equal to the amount ready to wash, for as long as the app runs.
    private func trackBadge() {
        withObservationTracking {
            NSApp.dockTile.badgeLabel = prefs.showAmount && hasResidue ? ByteFormat.string(washBytes) : nil
        } onChange: { [weak self] in
            Task { @MainActor in self?.trackBadge() }
        }
    }

    /// Saves the rules and preferences whenever anything changes them, from any window or menu.
    private func trackSettings() {
        withObservationTracking {
            _ = rules
            _ = prefs
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.saveSettings()
                self?.trackSettings()
            }
        }
    }

    /// Runs once a minute: the evening reminder, and an hourly look to keep the numbers honest.
    private func tick() async {
        let now = Date()
        // Once a day, measure where the space is, so a sudden jump can be traced to a day and a place.
        let lastLook = max(spaceHistory.snapshots.last?.date ?? .distantPast, lastSurveyAttempt)
        if !isSurveying, now.timeIntervalSince(lastLook) > 20 * 3600 {
            Task { await runSurvey() }
        }
        if prefs.ritualEnabled, ritualIsDue(now) {
            defaults.set(Self.dayKey(now), forKey: "lastRitualDay")
            await scan()
            if washBytes > 0 || !fileFindings.isEmpty {
                Notifier.shared.announce(bytes: washBytes, toFile: fileFindings.count)
            }
        } else if !(NSApp.isActive && ReviewWindow.shared.isVisible), phase == .review,
                  now.timeIntervalSince(result?.scannedAt ?? .distantPast) > 3600 {
            // Never under the owner's hands: only while they are looking elsewhere.
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

    /// Looks again. Returns once a pass that started after this call has finished.
    func scan() async {
        if isScanning {
            rescanQueued = true
            while isScanning { try? await Task.sleep(nanoseconds: 200_000_000) }
            return
        }
        isScanning = true
        repeat {
            rescanQueued = false
            let scanner = Scanner(
                locations: Locations(home: home, screenshotFolder: Platform.screenshotFolder(), archive: archive),
                rules: rules, now: Date(), usage: { Platform.usage($0) }, inUse: Platform.appsInUse(),
                runningIDs: Platform.runningBundleIDs())
            let fresh = await Task.detached(priority: .utility) { scanner.scan() }.value
            // The owner may have hidden something while the pass was running.
            let ignored = rules.ignored
            result = ScanResult(findings: fresh.findings.filter { !ignored.contains($0.id) }, scannedAt: fresh.scannedAt)
            // A choice only stands while the item is still there and still recommended the same way.
            selection.reconcile(with: fresh.findings)
        } while rescanQueued
        isScanning = false
    }

    // MARK: - Choices

    var allFindings: [Finding] { result?.findings ?? [] }

    /// What will happen to an item: the recommendation, unless the owner chose otherwise.
    func action(for finding: Finding) -> Verdict { selection.action(for: finding) }
    func isSelected(_ finding: Finding) -> Bool { selection.isSelected(finding) }
    func isOverruled(_ finding: Finding) -> Bool { selection.isOverruled(finding) }

    func setAction(_ finding: Finding, _ action: Verdict) { selection.set(finding, to: action) }
    func setAction(_ findings: [Finding], _ action: Verdict) { selection.set(findings, to: action) }

    func toggle(_ finding: Finding) { selection.toggle(finding) }
    func toggle(_ findings: [Finding]) { selection.toggle(findings) }
    func select(_ findings: [Finding]) { selection.select(findings) }
    func deselect(_ findings: [Finding]) { selection.deselect(findings) }
    func state(of findings: [Finding]) -> Selection.GroupState { selection.state(of: findings) }

    func selectAll() { selection.select(allFindings) }
    func selectNone() { selection.deselect(allFindings) }
    /// Back to what Rinse recommends, for everything or for some items.
    func resetSelection() { selection.reset() }
    func resetSelection(_ findings: [Finding]) { selection.reset(findings) }
    var hasChoices: Bool { selection.hasChoices }

    var selectedCount: Int { allFindings.filter(isSelected).count }

    func explanation(for finding: Finding) -> Explanation {
        finding.explanation(action: action(for: finding), home: home, archive: archive)
    }

    var washFindings: [Finding] { (result?.findings ?? []).filter { action(for: $0) == .wash } }
    var fileFindings: [Finding] { (result?.findings ?? []).filter { action(for: $0) == .file } }
    var washBytes: Int64 { washFindings.reduce(0) { $0 + $1.bytes } }
    var hasResidue: Bool { washBytes > 0 }
    var hasWork: Bool { !washFindings.isEmpty || !fileFindings.isEmpty }

    /// "Never show this again."
    func ignore(_ finding: Finding) {
        rules.ignored.insert(finding.id)
        selection.forget([finding.id])
        drop([finding.id])
    }

    private func drop(_ ids: Set<String>) {
        guard let current = result else { return }
        result = ScanResult(findings: current.findings.filter { !ids.contains($0.id) }, scannedAt: current.scannedAt)
    }

    // MARK: - Rinsing

    /// Washes what is marked to go and files what is marked to keep.
    func rinse() async {
        let toWash = washFindings, toFile = fileFindings
        guard !toWash.isEmpty || !toFile.isEmpty, phase != .working else { return }
        phase = .working
        let home = self.home, archive = self.archive
        // What is open or in the Dock right now, not when the list was made.
        let inUse = Platform.appsInUse(), runningIDs = Platform.runningBundleIDs()
        let protected = Platform.screenshotFolder().map { [$0] } ?? []
        let report = await Task.detached(priority: .userInitiated) {
            RinseReport(
                wash: Washer.wash(toWash, home: home, archive: archive, inUse: inUse, runningIDs: runningIDs,
                                  protected: protected, trasher: SystemTrasher()),
                file: Filer.file(toFile, home: home, archive: archive, inUse: inUse, runningIDs: runningIDs,
                                 protected: protected),
                archive: archive)
        }.value
        ledger.record(bytes: report.wash.bytes, count: report.wash.washed.count, at: Date())
        try? ledger.save(to: Self.ledgerURL)
        // Only what really moved is forgotten. A choice about something that would not move still stands.
        let moved = Set(report.wash.washed.map(\.id) + report.file.filed.map(\.id))
        selection.forget(moved)
        // Take what moved off the list now, so the numbers are right while the next look runs.
        drop(moved)
        lastReport = report
        phase = .clean
        await scan()
    }

    /// Puts the report away. Safe to call at any time; it does nothing while a rinse is running.
    func finishRinse() {
        guard phase == .clean else { return }
        phase = .review
        lastReport = nil
    }

    // MARK: - Windows

    /// Brings the window forward. It never throws away what is on screen.
    func openReview(settings: Bool = false) {
        if settings { showSettings = true }
        ReviewWindow.shared.show(model: self)
        if phase == .review, Date().timeIntervalSince(result?.scannedAt ?? .distantPast) > 300 {
            Task { await scan() }
        }
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
