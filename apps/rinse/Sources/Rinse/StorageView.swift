import AppKit
import RinseCore
import SwiftUI

/// Where the space on this Mac is, and what changed.
struct StorageView: View {
    @Environment(AppModel.self) private var model
    @State private var expanded: String?
    @State private var showAllPlaces = false

    var body: some View {
        if let survey = model.survey {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    DiskBar(survey: survey, importantAvailable: model.importantAvailable)
                    changes(survey)
                    if !model.snapshotDates.isEmpty { SnapshotsCard(dates: model.snapshotDates) }
                    places(survey)
                    footnote(survey)
                }
                .padding(20)
            }
        } else {
            VStack(spacing: 12) {
                ProgressView()
                Text("Measuring your home folder…")
                    .font(.headline)
                Text("This looks at every file once and can take a minute on a full Mac.")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .task { if !model.isSurveying { await model.runSurvey() } }
        }
    }

    // MARK: - What changed

    @ViewBuilder
    private func changes(_ survey: Survey) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let growth = model.growth {
                sectionTitle("What changed since \(growth.since.formatted(.dateTime.weekday(.wide).month().day()))",
                             "Compared with Rinse's look then. Only changes of 100 MB or more are shown.")
                let grew = growth.changes.filter { $0.delta > 0 }
                if grew.isEmpty {
                    Text("Nothing grew by 100 MB or more.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(grew.prefix(8)) { change in
                        ChangeRow(title: change.title, delta: change.delta, total: change.after,
                                  place: survey.entry(change.id)?.place, expanded: $expanded)
                    }
                }
            } else {
                sectionTitle("Created in the last week",
                             "Rinse has no earlier look to compare with yet, so this is an estimate: files created in the past 7 days. Files moved or copied in with their old dates are not counted, and big files that were only updated are listed separately because one look cannot tell how much they grew. From tomorrow Rinse can say exactly what grew.")
                let recent = survey.entries.filter { $0.newBytes >= 100_000_000 }.sorted { $0.newBytes > $1.newBytes }
                if recent.isEmpty {
                    Text("Less than 100 MB of new files anywhere Rinse can see.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(recent.prefix(8)) { entry in
                        ChangeRow(title: entry.place.title, delta: entry.newBytes, total: entry.bytes,
                                  place: entry.place, expanded: $expanded)
                    }
                }
            }
            fileList("Big files created this week", survey.newFiles, survey)
            fileList("Big files updated this week (size now, not growth)", survey.updatedFiles, survey)
        }
    }

    @ViewBuilder
    private func fileList(_ title: String, _ files: [Survey.RecentFile], _ survey: Survey) -> some View {
        if !files.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 6)
                ForEach(files.prefix(10)) { file in
                    HStack(spacing: 10) {
                        Image(nsImage: NSWorkspace.shared.icon(forFile: file.url.path))
                            .resizable()
                            .frame(width: 20, height: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(file.url.lastPathComponent)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text("\(survey.entry(file.placeID)?.place.title ?? "") · \(file.date.formatted(.relative(presentation: .named)))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(ByteFormat.string(file.bytes))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Button {
                            NSWorkspace.shared.activateFileViewerSelecting([file.url])
                        } label: {
                            Image(systemName: "magnifyingglass")
                        }
                        .buttonStyle(.borderless)
                        .help("Show in Finder")
                    }
                }
            }
        }
    }

    // MARK: - Where the space is

    private func places(_ survey: Survey) -> some View {
        let shown = survey.entries.filter { $0.bytes >= 50_000_000 && !$0.uncounted } + survey.entries.filter(\.uncounted)
        let largest = max(1, shown.first?.bytes ?? 1)
        return VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Where your space is", "Everything in your home folder, by place. Click a row for what it is and how to clear it safely.")
            ForEach(showAllPlaces ? shown : Array(shown.prefix(14))) { entry in
                PlaceRow(entry: entry, fraction: Double(entry.bytes) / Double(largest), expanded: $expanded)
            }
            if shown.count > 14 {
                Button(showAllPlaces ? "Show Fewer" : "Show All \(shown.count) Places") { showAllPlaces.toggle() }
                    .buttonStyle(.borderless)
            }
            if let outside = survey.outsideHome {
                HStack {
                    Image(systemName: "gearshape.2")
                        .frame(width: 20)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Outside your home folder")
                        Text(outsideHomeNote(survey))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Text(ByteFormat.string(outside))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }
        }
    }

    private func outsideHomeNote(_ survey: Survey) -> String {
        var note = "macOS itself, apps in Applications, other users, Time Machine snapshots and swap. System Settings › General › Storage splits this into macOS, Applications and System Data."
        if !survey.unreadablePlaces.isEmpty {
            note += " It also includes the folders Rinse could not read (\(survey.unreadableTitles.joined(separator: ", "))), because macOS counts them as used."
        }
        return note
    }

    private func footnote(_ survey: Survey) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Measured \(survey.measuredAt.formatted(.relative(presentation: .named))).")
            if !survey.unreadablePlaces.isEmpty {
                Text("Rinse could not read \(survey.unreadableTitles.joined(separator: ", ")) (macOS privacy protection), so their size is not shown and is counted under Outside your home folder. To count them, give Rinse Full Disk Access in System Settings › Privacy & Security › Full Disk Access. The first look after that starts a new comparison; it is not compared with earlier ones.")
            }
            if survey.incomplete {
                Text("Rinse stopped counting after 6 million files, so these sizes are too low and day-to-day growth cannot be tracked. The biggest places shown are still real.")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func sectionTitle(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.title3.weight(.semibold))
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Used and free space on the disk, as one bar.
private struct DiskBar: View {
    let survey: Survey
    let importantAvailable: Int64?

    var body: some View {
        if let disk = survey.disk, disk.total > 0 {
            let usedFraction = Double(disk.used) / Double(disk.total)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(ByteFormat.string(disk.available)) free")
                        .font(.system(size: 28, weight: .semibold, design: .rounded))
                    Text("of \(ByteFormat.string(disk.total))")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(ByteFormat.string(disk.used)) used")
                        .foregroundStyle(.secondary)
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.quaternary)
                        Capsule()
                            .fill(usedFraction > 0.9 ? AnyShapeStyle(Color.orange) : AnyShapeStyle(Color.water))
                            .frame(width: max(4, geo.size.width * usedFraction))
                    }
                }
                .frame(height: 10)
                if let important = importantAvailable, important > disk.available + 1_000_000_000 {
                    Text("macOS can free about \(ByteFormat.string(important - disk.available)) more on its own when it needs it (caches and snapshots it manages).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// One place that grew, with its explanation when clicked.
private struct ChangeRow: View {
    let title: String
    let delta: Int64
    let total: Int64
    let place: Place?
    @Binding var expanded: String?

    var body: some View {
        let key = "change:" + (place?.id ?? title)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded = expanded == key ? nil : key
            } label: {
                HStack {
                    Image(systemName: "arrow.up.right")
                        .foregroundStyle(Color.orange)
                        .frame(width: 20)
                    Text(title)
                    Spacer()
                    Text("+\(ByteFormat.string(delta))")
                        .monospacedDigit()
                        .fontWeight(.semibold)
                    Text("now \(ByteFormat.string(total))")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 90, alignment: .trailing)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded == key, let place { PlaceDetail(place: place).padding(.leading, 28) }
        }
    }
}

/// One place, with a bar for its size and its explanation when clicked.
private struct PlaceRow: View {
    let entry: Survey.Entry
    let fraction: Double
    @Binding var expanded: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded = expanded == entry.id ? nil : entry.id
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Image(systemName: symbol)
                            .frame(width: 20)
                            .foregroundStyle(.secondary)
                        Text(entry.place.title)
                        if entry.newBytes >= 100_000_000 {
                            Text("+\(ByteFormat.string(entry.newBytes)) new this week")
                                .font(.caption)
                                .foregroundStyle(Color.orange)
                        }
                        Spacer()
                        Text(entry.uncounted ? "Not counted" : ByteFormat.string(entry.bytes))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .help(entry.uncounted ? "macOS only lets Rinse measure this with Full Disk Access" : "")
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(.quaternary)
                            Capsule().fill(Color.water)
                                .frame(width: max(3, geo.size.width * fraction))
                        }
                    }
                    .frame(height: 4)
                    .padding(.leading, 28)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded == entry.id { PlaceDetail(place: entry.place).padding(.leading, 28) }
        }
    }

    private var symbol: String {
        switch entry.place.group {
        case .yours: return "person.crop.square"
        case .apps: return "app.badge"
        case .developer: return "hammer"
        case .system: return "gearshape.2"
        }
    }
}

/// What a place is, how to clear it, and a way to look.
private struct PlaceDetail: View {
    @Environment(AppModel.self) private var model
    let place: Place

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(place.explanation)
                .fixedSize(horizontal: false, vertical: true)
            if let how = place.howToClear {
                Text(how)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            HStack(spacing: 12) {
                if let url = location {
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                }
                if place.cleanedBy != nil {
                    Button("Review in Rinse") { model.pane = .rinse }
                }
            }
            .buttonStyle(.borderless)
        }
        .font(.callout)
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }

    private var location: URL? {
        guard !place.path.isEmpty else { return FileManager.default.homeDirectoryForCurrentUser }
        let path = place.path.contains("*") ? (place.path as NSString).deletingLastPathComponent : place.path
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

/// Time Machine's local snapshots: what they are and how to clear them.
private struct SnapshotsCard: View {
    let dates: [Date]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(Color.water)
                Text("\(dates.count) Time Machine snapshot\(dates.count == 1 ? "" : "s") on this Mac")
                    .font(.headline)
            }
            if let first = dates.first, let last = dates.last {
                Text("From \(first.formatted(date: .abbreviated, time: .shortened)) to \(last.formatted(date: .abbreviated, time: .shortened)).")
                    .foregroundStyle(.secondary)
            }
            Text("Time Machine keeps a snapshot of this Mac every hour for 24 hours, plus one of the last successful backup. Snapshots hold on to files you have since deleted or changed, so deleting a big file does not free its space until the snapshots taken before that are gone. macOS counts this space as purgeable and removes snapshots by itself when it needs room. If backups have been failing, the snapshot of the last successful backup can hold old data for a long time.")
                .fixedSize(horizontal: false, vertical: true)
            Text("Best: connect the backup disk and let a backup finish; old snapshots then go on their own. Only if you need the space right now, run in Terminal:  tmutil thinlocalsnapshots / 999999999999 4  (how many bytes to try to free, then the highest urgency).")
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text("That deletes these restore points: files you deleted or changed since your last completed backup can no longer be brought back. Your files and the backups on your backup disk are not touched.")
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
}
