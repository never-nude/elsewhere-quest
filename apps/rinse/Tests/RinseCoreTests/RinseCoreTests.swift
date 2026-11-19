import XCTest
@testable import RinseCore
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A throwaway home folder with files whose ages the tests control.
final class FakeHome {
    let url: URL
    let now = Date()

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("rinse-tests-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    @discardableResult
    func file(_ relative: String, kilobytes: Int = 4, daysOld: Int = 0) throws -> URL {
        let target = url.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Random bytes, so no file system can store the file in less space than its length.
        var bytes = [UInt8](repeating: 0, count: kilobytes * 1000)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        try Data(bytes).write(to: target)
        age(target, days: daysOld)
        return target
    }

    @discardableResult
    func folder(_ relative: String, daysOld: Int = 0) throws -> URL {
        let target = url.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        age(target, days: daysOld)
        return target
    }

    /// Sets both the access and the modification time to `days` ago.
    func age(_ target: URL, days: Int) {
        let then = now.addingTimeInterval(-Double(days) * 86_400 - 60)
        let stamp = timeval(tv_sec: Int(then.timeIntervalSince1970), tv_usec: 0)
        var times = [stamp, stamp]
        XCTAssertEqual(utimes(target.path, &times), 0)
    }

    /// Names the tests want treated as downloaded from the web, or as never opened.
    var downloaded: Set<String> = []
    var neverOpened: Set<String> = []
    var opened: Set<String> = []
    var archive: URL?

    func scan(_ rules: Rules = Rules(), screenshotFolder: URL? = nil) -> ScanResult {
        let (downloaded, neverOpened, opened) = (self.downloaded, self.neverOpened, self.opened)
        return Scanner(
            locations: Locations(home: url, screenshotFolder: screenshotFolder, archive: archive),
            rules: rules, now: now,
            usage: { url in
                if neverOpened.contains(url.lastPathComponent) { return Usage(lastOpened: nil) }
                if opened.contains(url.lastPathComponent) { return Usage(lastOpened: Date(timeIntervalSince1970: 1)) }
                return nil
            },
            hasOrigin: { downloaded.contains($0.lastPathComponent) }).scan()
    }
}

/// Stands in for the Trash by moving items into a folder outside the fake home.
struct FolderTrasher: Trasher {
    let bin: URL
    func trash(_ url: URL) throws {
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: url, to: bin.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent))
    }
}

final class ScannerTests: XCTestCase {
    var home: FakeHome!

    override func setUpWithError() throws { home = try FakeHome() }
    override func tearDown() { home = nil }

    private func folder_verdict(_ result: ScanResult) -> Verdict? { find(result, "Old Project")?.verdict }

    private func find(_ result: ScanResult, _ name: String) -> Finding? {
        result.findings.first { $0.url.lastPathComponent == name }
    }

    func testOldScreenshotsArePreCheckedAndFreshOnesOnlyListed() throws {
        try home.file("Desktop/Screenshot 2026-11-01 at 9.41.00 AM.png", daysOld: 12)
        try home.file("Desktop/Screenshot 2026-11-18 at 8.00.00 AM.png", daysOld: 0)
        try home.file("Desktop/holiday.png", daysOld: 400)
        let result = home.scan()

        let old = try XCTUnwrap(find(result, "Screenshot 2026-11-01 at 9.41.00 AM.png"))
        XCTAssertEqual(old.category, .screenshots)
        XCTAssertEqual(old.verdict, .wash)
        XCTAssertEqual(old.reason, "Taken 12 days ago · no record of you opening it")
        let fresh = try XCTUnwrap(find(result, "Screenshot 2026-11-18 at 8.00.00 AM.png"))
        XCTAssertEqual(fresh.verdict, .leave)
        XCTAssertEqual(fresh.reason, "Taken today · still recent")
        XCTAssertNil(find(result, "holiday.png"), "an ordinary picture is not a screenshot")
    }

    func testScreenshotsInACustomFolderAreFound() throws {
        let shots = try home.folder("Pictures/Shots")
        try home.file("Pictures/Shots/Screenshot 1.png", daysOld: 30)
        XCTAssertNil(find(home.scan(), "Screenshot 1.png"))
        XCTAssertEqual(find(home.scan(screenshotFolder: shots), "Screenshot 1.png")?.category, .screenshots)
    }

    func testScreenRecordingsAreTheirOwnCategory() throws {
        try home.file("Desktop/Screen Recording 2026-10-01 at 3.00.00 PM.mov", daysOld: 40)
        try home.file("Movies/wedding.mov", daysOld: 40)
        let result = home.scan()
        XCTAssertEqual(find(result, "Screen Recording 2026-10-01 at 3.00.00 PM.mov")?.category, .recordings)
        XCTAssertNil(find(result, "wedding.mov"))
    }

    func testInstallersAreClaimedOnceAndNotAlsoListedAsStaleDownloads() throws {
        try home.file("Downloads/Xcode_26.dmg", daysOld: 45)
        try home.file("Downloads/tool.pkg", daysOld: 1)
        home.downloaded = ["Xcode_26.dmg", "tool.pkg"]
        let result = home.scan()
        XCTAssertEqual(result.findings.filter { $0.url.lastPathComponent == "Xcode_26.dmg" }.count, 1)
        XCTAssertEqual(find(result, "Xcode_26.dmg")?.category, .installers)
        XCTAssertEqual(find(result, "Xcode_26.dmg")?.verdict, .wash)
        XCTAssertEqual(find(result, "tool.pkg")?.verdict, .leave, "a one-day-old installer may not have been run yet")
    }

    func testStaleDownloadsAreListedButNeverPreChecked() throws {
        try home.file("Downloads/tax-return.pdf", daysOld: 200)
        try home.file("Downloads/Old Project/notes.txt", kilobytes: 50, daysOld: 200)
        home.age(home.url.appendingPathComponent("Downloads/Old Project"), days: 200)
        try home.file("Downloads/fresh.pdf", daysOld: 2)
        let result = home.scan()

        let pdf = try XCTUnwrap(find(result, "tax-return.pdf"))
        XCTAssertEqual(pdf.category, .staleDownloads)
        XCTAssertEqual(pdf.verdict, .file, "a document is filed, never washed")
        XCTAssertEqual(folder_verdict(result), .file)
        let folder = try XCTUnwrap(find(result, "Old Project"))
        XCTAssertTrue(folder.isDirectory)
        XCTAssertGreaterThanOrEqual(folder.bytes, 50_000, "a folder counts everything inside it")
        XCTAssertNil(find(result, "fresh.pdf"))
        XCTAssertNil(find(result, "notes.txt"), "files inside a listed folder are not listed again")
    }

    func testCachesSkipAppleAndTinyOnesAndPreCheckBigOnes() throws {
        var rules = Rules()
        rules.cacheListBytes = 50_000
        rules.cacheSuggestBytes = 300_000
        try home.file("Library/Caches/com.apple.Safari/data", kilobytes: 800)
        try home.file("Library/Caches/com.spotify.client/blob", kilobytes: 800)
        try home.file("Library/Caches/com.medium.app/blob", kilobytes: 100)
        try home.file("Library/Caches/com.tiny.app/blob", kilobytes: 1)
        let result = home.scan(rules)

        XCTAssertNil(find(result, "com.apple.Safari"))
        XCTAssertNil(find(result, "com.tiny.app"))
        XCTAssertEqual(find(result, "com.spotify.client")?.verdict, .wash)
        XCTAssertEqual(find(result, "com.medium.app")?.verdict, .leave)
        XCTAssertEqual(find(result, "com.spotify.client")?.category, .caches)
    }

    func testDeveloperLeftovers() throws {
        var rules = Rules()
        rules.cacheListBytes = 50_000
        rules.cacheSuggestBytes = 300_000
        try home.file("Library/Developer/Xcode/DerivedData/Old-abc/Build/x.o", kilobytes: 100)
        home.age(home.url.appendingPathComponent("Library/Developer/Xcode/DerivedData/Old-abc"), days: 20)
        try home.file("Library/Developer/Xcode/DerivedData/Live-def/Build/x.o", kilobytes: 100)
        try home.file(".npm/_cacache/content/blob", kilobytes: 500)
        try home.file(".cache/pip/wheel", kilobytes: 500)
        try home.file(".cache/somemodels/weights.bin", kilobytes: 500)
        try home.file(".cache/huggingface/token", kilobytes: 500)
        // Xcode writes deep inside a build folder, so the folder's own date says nothing.
        try home.file("Library/Developer/Xcode/DerivedData/Daily-ghi/Logs/Build/today.xcactivitylog", kilobytes: 100)
        home.age(home.url.appendingPathComponent("Library/Developer/Xcode/DerivedData/Daily-ghi"), days: 40)
        home.age(home.url.appendingPathComponent("Library/Developer/Xcode/DerivedData/Daily-ghi/Logs"), days: 40)
        let result = home.scan(rules)

        XCTAssertEqual(find(result, "Old-abc")?.verdict, .wash)
        XCTAssertEqual(find(result, "Live-def")?.verdict, .leave)
        XCTAssertEqual(find(result, "Daily-ghi")?.verdict, .leave, "built today, whatever the top folder says")
        XCTAssertEqual(find(result, "pip")?.verdict, .wash)
        XCTAssertEqual(find(result, "somemodels")?.verdict, .leave, "an unknown tool folder is never pre-chosen")
        XCTAssertNil(find(result, "huggingface"), "model and login stores are not listed at all")
        let npm = try XCTUnwrap(find(result, "_cacache"))
        XCTAssertEqual(npm.name, "npm cache")
        XCTAssertEqual(npm.category, .developer)
        XCTAssertEqual(npm.verdict, .wash)
        XCTAssertEqual(find(result, "pip")?.category, .developer)
    }

    func testBigIdleFilesAreFoundDeepButNotInsidePackages() throws {
        var rules = Rules()
        rules.bigFileBytes = 300_000
        try home.file("Documents/Archive/2019/render.mov", kilobytes: 600, daysOld: 300)
        try home.file("Documents/Archive/2019/small.txt", kilobytes: 2, daysOld: 300)
        try home.file("Documents/active.psd", kilobytes: 600, daysOld: 3)
        try home.file("Movies/Final.fcpbundle/media/clip.mov", kilobytes: 600, daysOld: 300)
        let result = home.scan(rules)

        let render = try XCTUnwrap(find(result, "render.mov"))
        XCTAssertEqual(render.category, .bigIdle)
        XCTAssertEqual(render.verdict, .leave, "same disk: moving it would free nothing")
        XCTAssertNil(find(result, "small.txt"))
        XCTAssertNil(find(result, "active.psd"))
        XCTAssertNil(find(result, "clip.mov"), "a library or project bundle is one document")
    }

    func testIgnoredPathsAndDisabledCategoriesStayOut() throws {
        let shot = try home.file("Desktop/Screenshot keep.png", daysOld: 30)
        try home.file("Downloads/app.dmg", daysOld: 30)
        var rules = Rules()
        rules.ignored = [shot.path]
        rules.disabled = [.installers, .staleDownloads]
        XCTAssertTrue(home.scan(rules).findings.isEmpty)
    }

    func testAnEmptyHomeScansClean() {
        let result = home.scan()
        XCTAssertTrue(result.findings.isEmpty)
        XCTAssertEqual(result.totalBytes, 0)
        XCTAssertTrue(result.categories.isEmpty)
    }

    func testTotals() throws {
        try home.file("Desktop/Screenshot a.png", kilobytes: 100, daysOld: 30)
        try home.file("Desktop/Screenshot b.png", kilobytes: 100, daysOld: 0)
        let result = home.scan()
        XCTAssertEqual(result.categories, [.screenshots])
        XCTAssertGreaterThanOrEqual(result.totalBytes, 200_000)
        XCTAssertLessThan(result.washBytes, result.totalBytes)
        XCTAssertGreaterThan(result.washBytes, 0)
        XCTAssertEqual(result.bytes(in: .screenshots), result.totalBytes)
    }
}

extension ScannerTests {
    func testADiskImageWithNoDownloadRecordIsNeverWashed() throws {
        try home.file("Desktop/Taxes.dmg", daysOld: 45)
        try home.file("Downloads/Installer.dmg", daysOld: 45)
        home.downloaded = ["Installer.dmg"]
        let result = home.scan()
        XCTAssertEqual(find(result, "Installer.dmg")?.verdict, .wash)
        let own = try XCTUnwrap(find(result, "Taxes.dmg"))
        XCTAssertEqual(own.verdict, .file)
        XCTAssertTrue(own.reason.contains("may be your own"))
    }

    func testOpenedScreenshotsAreFiledAndUnopenedOnesGo() throws {
        try home.file("Desktop/Screenshot used.png", daysOld: 30)
        try home.file("Desktop/Screenshot unused.png", daysOld: 30)
        try home.file("Desktop/Screen Recording used.mov", daysOld: 30)
        try home.file("Desktop/Screen Recording unused.mov", daysOld: 30)
        home.opened = ["Screenshot used.png", "Screen Recording used.mov"]
        let result = home.scan()
        XCTAssertEqual(find(result, "Screenshot used.png")?.verdict, .file)
        XCTAssertEqual(find(result, "Screenshot unused.png")?.verdict, .wash)
        XCTAssertEqual(find(result, "Screen Recording used.mov")?.verdict, .file)
        XCTAssertEqual(find(result, "Screen Recording unused.mov")?.verdict, .file, "a recording is never washed on silence")
    }

    func testDownloadsSplitByWhatTheyAre() throws {
        try home.file("Downloads/project.zip", daysOld: 90)
        try home.file("Downloads/statement.pdf", daysOld: 90)
        try home.file("Downloads/clip.mov", daysOld: 90)
        try home.file("Downloads/portfolio.zip", daysOld: 90)
        try home.file("Downloads/IMG_1234.CR2", daysOld: 90)
        try home.file("Downloads/Tool.app/Contents/MacOS/tool", daysOld: 90)
        home.age(home.url.appendingPathComponent("Downloads/Tool.app"), days: 90)
        try FileManager.default.createSymbolicLink(atPath: home.url.appendingPathComponent("Downloads/latest").path,
                                                   withDestinationPath: "project.zip")
        home.downloaded = ["project.zip", "statement.pdf", "clip.mov", "IMG_1234.CR2"]
        let result = home.scan()
        XCTAssertEqual(find(result, "project.zip")?.verdict, .wash)
        XCTAssertEqual(find(result, "portfolio.zip")?.verdict, .file, "an archive with no download record may be the only copy")
        XCTAssertEqual(find(result, "IMG_1234.CR2")?.verdict, .file, "an unknown kind of file is never washed")
        XCTAssertNil(find(result, "Tool.app"))
        XCTAssertNil(find(result, "latest"))
        XCTAssertEqual(find(result, "statement.pdf")?.verdict, .file, "a document stays yours even if it could be fetched again")
        XCTAssertEqual(find(result, "clip.mov")?.verdict, .file)
    }

    func testTheFilingFolderIsNeverScanned() throws {
        home.archive = home.url.appendingPathComponent("Downloads/Filed")
        try home.file("Downloads/Filed/Screenshots/2025-01/Screenshot old.png", daysOld: 300)
        home.age(home.url.appendingPathComponent("Downloads/Filed"), days: 300)
        var rules = Rules()
        rules.bigFileBytes = 1
        XCTAssertTrue(home.scan(rules).findings.isEmpty)
    }

    func testRecommendationsComeSurestFirst() throws {
        try home.file("Desktop/Screenshot a.png", daysOld: 8)
        try home.file("Desktop/Screenshot b.png", daysOld: 300)
        let washes = home.scan().findings(recommended: .wash)
        XCTAssertEqual(washes.map(\.url.lastPathComponent), ["Screenshot b.png", "Screenshot a.png"])
        XCTAssertGreaterThan(washes[0].assessment.confidence, washes[1].assessment.confidence)
    }
}

final class JudgeTests: XCTestCase {
    private func judge(_ kind: Residue, _ name: String = "x", idle: Int = 0, limit: Judge.Limit = .age(days: 7),
                       bytes: Int64 = 0, origin: Bool = false, usage: Usage? = nil, directory: Bool = false,
                       otherDisk: Bool = false) -> Assessment {
        Judge.assess(Judge.Evidence(kind: kind, name: name, isDirectory: directory, bytes: bytes, idleDays: idle,
                                    limit: limit, hasOrigin: origin, usage: usage, filingFreesSpace: otherDisk))
    }

    func testNothingIsRecommendedBeforeItsLimit() {
        for kind in Residue.allCases {
            XCTAssertEqual(judge(kind, idle: 6, limit: .age(days: 7), origin: true).verdict, .leave, "\(kind)")
        }
        XCTAssertEqual(judge(.caches, limit: .size(bytes: 100), bytes: 99).verdict, .leave)
        XCTAssertEqual(judge(.caches, limit: .size(bytes: 100), bytes: 100).verdict, .wash)
    }

    func testConfidenceGrowsWithIdleTimeAndStaysInRange() {
        var last = 0
        for idle in [7, 14, 30, 90, 400, 4000] {
            let a = judge(.screenshots, idle: idle)
            XCTAssertEqual(a.verdict, .wash)
            XCTAssertGreaterThanOrEqual(a.confidence, last)
            XCTAssertTrue((0...100).contains(a.confidence))
            last = a.confidence
        }
        XCTAssertGreaterThan(last, judge(.screenshots, idle: 7).confidence)
    }

    func testYourOwnThingsAreFiledNotWashed() {
        XCTAssertEqual(judge(.staleDownloads, "thesis.pages", idle: 400, limit: .age(days: 30)).verdict, .file)
        XCTAssertEqual(judge(.staleDownloads, "Project", idle: 400, limit: .age(days: 30), directory: true).verdict, .file)
        XCTAssertEqual(judge(.staleDownloads, "photo.heic", idle: 400, limit: .age(days: 30), origin: true,
                             usage: Usage(lastOpened: nil)).verdict, .file)
        for kind in [Residue.staleDownloads, .bigIdle] {
            for name in ["unknown.xyz", "noextension", "passwords.kdbx"] {
                XCTAssertNotEqual(judge(kind, name, idle: 4000, limit: .age(days: 30), origin: true,
                                        usage: Usage(lastOpened: nil), otherDisk: true).verdict, .wash, name)
            }
            XCTAssertNotEqual(judge(kind, "backup.dmg", idle: 4000, limit: .age(days: 30)).verdict, .wash)
            XCTAssertEqual(judge(kind, "bundle.zip", idle: 400, limit: .age(days: 30), origin: true).verdict, .wash)
        }
        XCTAssertEqual(judge(.screenshots, idle: 0, limit: .age(days: 0)).verdict, .leave, "a limit of 0 still means a day")
    }

    func testBigIdleFilesAreOnlyFiledWhenThatFreesSpace() {
        XCTAssertEqual(judge(.bigIdle, "render.mov", idle: 400, limit: .age(days: 60)).verdict, .leave)
        XCTAssertEqual(judge(.bigIdle, "render.mov", idle: 400, limit: .age(days: 60), otherDisk: true).verdict, .file)
        XCTAssertEqual(judge(.bigIdle, "ubuntu.iso", idle: 400, limit: .age(days: 60), origin: true).verdict, .wash)
    }

    func testRenamedCapturesAndUnknownToolDataAreProtected() {
        var e = Judge.Evidence(kind: .screenshots, name: "Passport receipt.png", idleDays: 400, limit: .age(days: 7))
        e.renamed = true
        XCTAssertEqual(Judge.assess(e).verdict, .file)
        var tool = Judge.Evidence(kind: .developer, name: "models", bytes: 1_000_000_000, idleDays: 0, limit: .size(bytes: 100))
        tool.regenerable = false
        XCTAssertEqual(Judge.assess(tool).verdict, .leave)
    }
}

final class FilerTests: XCTestCase {
    func testFilingSortsByKindAndMonthAndNeverOverwrites() throws {
        let home = try FakeHome()
        let archive = home.url.appendingPathComponent("Documents/Filed Away")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        try home.file("Downloads/statement.pdf", daysOld: 90)
        let first = home.scan().findings
        XCTAssertEqual(first.map(\.verdict), [.file])
        let month = Filer.folder(for: first[0], home: home.url, archive: archive, calendar: utc)
        XCTAssertEqual(month.deletingLastPathComponent().lastPathComponent, "Stale downloads")
        XCTAssertEqual(month.lastPathComponent.count, 7)

        let one = Filer.file(first, home: home.url, archive: archive, calendar: utc)
        XCTAssertEqual(one.filed.map(\.destination.lastPathComponent), ["statement.pdf"])
        XCTAssertTrue(one.failures.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first[0].url.path))

        try home.file("Downloads/statement.pdf", daysOld: 90)
        let two = Filer.file(home.scan().findings, home: home.url, archive: archive, calendar: utc)
        XCTAssertEqual(two.filed.map(\.destination.lastPathComponent), ["statement 2.pdf"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: month.path).sorted(), ["statement 2.pdf", "statement.pdf"])
        XCTAssertTrue(home.scan().findings.isEmpty, "filed items are out of Rinse's sight")
    }

    func testABigFileKeepsItsPlaceWhenFiled() throws {
        let home = try FakeHome()
        let other = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-archive-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: other) }
        let url = try home.file("Documents/Clients/Acme/footage/interview.mov", kilobytes: 8, daysOld: 400)
        let finding = Finding(url: url, name: "interview.mov", category: .bigIdle, bytes: 8000,
                              lastTouched: home.now.addingTimeInterval(-400 * 86_400), isDirectory: false,
                              assessment: Assessment(verdict: .file, confidence: 90, reasons: []))
        let report = Filer.file([finding], home: home.url, archive: other)
        XCTAssertEqual(report.filed.first?.destination.path,
                       other.appendingPathComponent("Big and idle/Documents/Clients/Acme/footage/interview.mov").path)
    }

    func testNothingMovesIfItChangedSinceTheScan() throws {
        let home = try FakeHome()
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: bin) }
        let shot = try home.file("Desktop/Screenshot a.png", daysOld: 30)
        let doc = try home.file("Downloads/statement.pdf", daysOld: 90)
        let found = home.scan().findings
        XCTAssertEqual(found.count, 2)
        home.age(shot, days: 0)   // someone edited both after Rinse looked
        home.age(doc, days: 0)
        let wash = Washer.wash(found.filter { $0.verdict == .wash }, home: home.url, trasher: FolderTrasher(bin: bin))
        let file = Filer.file(found.filter { $0.verdict == .file }, home: home.url, archive: home.url.appendingPathComponent("Documents/Filed Away"))
        XCTAssertEqual(wash.failures.map(\.message) + file.failures.map(\.message),
                       ["Changed since Rinse looked", "Changed since Rinse looked"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: shot.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: doc.path))
    }

    func testAFilingFolderInAScannedPlaceGetsItsOwnFolder() throws {
        let home = URL(fileURLWithPath: "/Users/someone")
        func filing(_ path: String?) -> String {
            Locations.filingFolder(chosen: path.map { URL(fileURLWithPath: $0) }, home: home,
                                   screenshotFolder: URL(fileURLWithPath: "/Users/someone/Pictures/Shots")).path
        }
        XCTAssertEqual(filing(nil), "/Users/someone/Documents/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Documents"), "/Users/someone/Documents/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Documents/"), "/Users/someone/Documents/Filed Away")
        XCTAssertEqual(filing("/Users/someone"), "/Users/someone/Filed Away")
        XCTAssertEqual(filing("/Users"), "/Users/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Pictures/Shots"), "/Users/someone/Pictures/Shots/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Documents/Archive"), "/Users/someone/Documents/Archive")
        XCTAssertEqual(filing("/Volumes/Backup/Filed"), "/Volumes/Backup/Filed")
    }

    func testFiledThingsNeverComeBackAsFindings() throws {
        let home = try FakeHome()
        home.archive = home.url.appendingPathComponent("Documents")   // the owner picked Documents itself
        try home.file("Downloads/statement.pdf", daysOld: 90)
        let found = home.scan().findings
        let archive = Locations(home: home.url, archive: home.archive).archive
        XCTAssertEqual(archive.lastPathComponent, "Filed Away")
        XCTAssertEqual(Filer.file(found, home: home.url, archive: archive).filed.count, 1)
        var rules = Rules()
        rules.bigFileBytes = 1
        rules.bigFileIdleDays = 1
        XCTAssertTrue(home.scan(rules).findings.isEmpty)
    }

    func testAFolderThatHoldsTheFilingFolderIsNeverAFindingAndNeverWashed() throws {
        let home = try FakeHome()
        home.archive = home.url.appendingPathComponent("Downloads/Old/Filed")
        try home.file("Downloads/Old/Filed/Screenshots/2025-01/keep.png", daysOld: 300)
        let old = home.url.appendingPathComponent("Downloads/Old")
        home.age(old, days: 300)
        XCTAssertTrue(home.scan().findings.isEmpty)
        let forced = Finding(url: old, name: "Old", category: .staleDownloads, bytes: 1, lastTouched: Date(),
                             isDirectory: true, assessment: Assessment(verdict: .wash, confidence: 100, reasons: []))
        let report = Washer.wash([forced], home: home.url, archive: home.archive,
                                 trasher: FolderTrasher(bin: home.url.appendingPathComponent("bin")))
        XCTAssertEqual(report.failures.map(\.message), ["It holds the filing folder"])
    }

    func testFilingRefusesCachesProtectedPlacesAndItself() throws {
        let home = try FakeHome()
        let archive = try home.folder("Documents/Filed Away")
        func finding(_ url: URL, _ kind: Residue) -> Finding {
            Finding(url: url, name: url.lastPathComponent, category: kind, bytes: 1, lastTouched: Date(),
                    isDirectory: true, assessment: Assessment(verdict: .file, confidence: 100, reasons: []))
        }
        let cache = try home.folder("Library/Caches/com.some.app")
        let documents = home.url.appendingPathComponent("Documents")
        let inside = try home.folder("Documents/Filed Away/Screenshots")
        let report = Filer.file(
            [finding(cache, .caches), finding(documents, .bigIdle), finding(inside, .bigIdle), finding(archive, .bigIdle)],
            home: home.url, archive: archive)
        XCTAssertTrue(report.filed.isEmpty)
        XCTAssertEqual(report.failures.count, 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: inside.path))
    }
}

extension ScannerTests {
    func testAFolderIsAsFreshAsTheNewestThingInside() throws {
        try home.file("Downloads/thesis/chapters/ch3.tex", daysOld: 1)
        try home.file("Downloads/abandoned/notes.txt", daysOld: 200)
        for name in ["thesis", "thesis/chapters", "abandoned"] {
            home.age(home.url.appendingPathComponent("Downloads/" + name), days: 200)
        }
        let result = home.scan()
        XCTAssertNil(find(result, "thesis"), "edited yesterday, whatever the folder's own date says")
        XCTAssertEqual(find(result, "abandoned")?.verdict, .file)
    }

    func testOnlyAWebAddressCountsAsADownloadRecord() throws {
        func record(_ values: [String]) throws -> Data {
            try PropertyListSerialization.data(fromPropertyList: values, format: .binary, options: 0)
        }
        XCTAssertTrue(FileStat.isWebOrigin(try record(["https://example.com/app.dmg", "https://example.com/"])))
        XCTAssertTrue(FileStat.isWebOrigin(try record(["", "HTTP://example.com/file.zip"])))
        XCTAssertFalse(FileStat.isWebOrigin(try record(["Someone's iPhone"])), "AirDrop")
        XCTAssertFalse(FileStat.isWebOrigin(try record(["message:%3Cabc@mail.example%3E"])), "Mail")
        XCTAssertFalse(FileStat.isWebOrigin(try record([])))
        XCTAssertFalse(FileStat.isWebOrigin(Data("not a property list".utf8)))
    }
}

final class WasherTests: XCTestCase {
    func testWashMovesFilesAndReportsWhatItCouldNot() throws {
        let home = try FakeHome()
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: bin) }
        let shot = try home.file("Desktop/Screenshot a.png", daysOld: 30)
        try home.file("Downloads/app.dmg", daysOld: 30)
        home.downloaded = ["app.dmg"]
        let scan = home.scan()
        XCTAssertEqual(scan.findings.count, 2)

        try FileManager.default.removeItem(at: home.url.appendingPathComponent("Downloads/app.dmg"))
        let report = Washer.wash(scan.findings, home: home.url, trasher: FolderTrasher(bin: bin))

        XCTAssertEqual(report.washed.map(\.url), [shot])
        XCTAssertEqual(report.failures.map(\.message), ["Already gone"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: shot.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bin.path).count, 1)
        XCTAssertEqual(report.bytes, report.washed[0].bytes)
    }

    func testWashRefusesProtectedLocationsEvenIfHandedThem() throws {
        let home = try FakeHome()
        let desktop = try home.folder("Desktop")
        let finding = Finding(url: desktop, name: "Desktop", category: .bigIdle, bytes: 1, lastTouched: Date(),
                              isDirectory: true, assessment: Assessment(verdict: .wash, confidence: 100, reasons: []))
        let report = Washer.wash([finding], home: home.url, trasher: FolderTrasher(bin: home.url.appendingPathComponent("x")))
        XCTAssertTrue(report.washed.isEmpty)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: desktop.path))
    }

    func testSafetyGuard() {
        let home = URL(fileURLWithPath: "/Users/someone")
        func ok(_ path: String) -> Bool { SafetyGuard.canWash(URL(fileURLWithPath: path), home: home) }

        XCTAssertTrue(ok("/Users/someone/Desktop/Screenshot.png"))
        XCTAssertTrue(ok("/Users/someone/Library/Caches/com.spotify.client"))
        XCTAssertTrue(ok("/Users/someone/Library/Developer/Xcode/DerivedData/App-abc"))
        XCTAssertTrue(ok("/Users/someone/.npm/_cacache"))

        XCTAssertFalse(ok("/Users/someone"))
        XCTAssertFalse(ok("/Users/someone/Desktop"))
        XCTAssertFalse(ok("/Users/someone/Library"))
        XCTAssertFalse(ok("/Users/someone/Library/Caches"))
        XCTAssertFalse(ok("/Users/someone/Library/Developer/Xcode/DerivedData"))
        XCTAssertFalse(ok("/Users/someone/Library/Application Support/Notes"))
        XCTAssertFalse(ok("/Users/someone/Library/Mail/V10"))
        XCTAssertFalse(ok("/Users/someone/.Trash/thing"))
        XCTAssertFalse(ok("/Users/someone/Desktop/../../other/file"))
        XCTAssertFalse(ok("/Users/someone-else/Desktop/file"))
        XCTAssertFalse(ok("/Applications/Safari.app"))
        XCTAssertFalse(ok("/"))
    }
}

final class LedgerTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }()

    private func day(_ d: Int, hour: Int = 21) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: d, hour: hour))!
    }

    func testStreakCountsConsecutiveDaysAndForgivesAnOpenToday() {
        var ledger = Ledger()
        XCTAssertEqual(ledger.streak(asOf: day(18), calendar: calendar), 0)
        ledger.record(bytes: 10, count: 1, at: day(14))
        ledger.record(bytes: 10, count: 1, at: day(16))
        ledger.record(bytes: 10, count: 2, at: day(17))
        ledger.record(bytes: 10, count: 1, at: day(17, hour: 23))
        XCTAssertEqual(ledger.streak(asOf: day(18, hour: 9), calendar: calendar), 2, "today is still open")
        ledger.record(bytes: 10, count: 1, at: day(18))
        XCTAssertEqual(ledger.streak(asOf: day(18, hour: 22), calendar: calendar), 3)
        XCTAssertEqual(ledger.streak(asOf: day(20), calendar: calendar), 0, "a missed day ends it")
        XCTAssertEqual(ledger.totalBytes, 50)
    }

    func testAnEmptyWashIsNotRecorded() {
        var ledger = Ledger()
        ledger.record(bytes: 0, count: 0, at: Date())
        XCTAssertTrue(ledger.entries.isEmpty)
    }

    func testLedgerSurvivesSavingAndLoading() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-ledger-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        var ledger = Ledger()
        ledger.record(bytes: 1234, count: 3, at: Date(timeIntervalSince1970: 1_800_000_000))
        try ledger.save(to: url)
        XCTAssertEqual(Ledger.load(from: url), ledger)
        XCTAssertEqual(Ledger.load(from: url.appendingPathExtension("missing")), Ledger())
    }

    func testByteFormat() {
        XCTAssertEqual(ByteFormat.string(0), "0 KB")
        XCTAssertEqual(ByteFormat.string(512_000), "512 KB")
        XCTAssertEqual(ByteFormat.string(48_400_000), "48 MB")
        XCTAssertEqual(ByteFormat.string(3_420_000_000), "3.4 GB")
        XCTAssertEqual(ByteFormat.string(2_000_000_000), "2 GB")
        XCTAssertEqual(ByteFormat.string(128_600_000_000), "129 GB")
        XCTAssertEqual(ByteFormat.string(1_500_000_000_000), "1.5 TB")
    }
}
