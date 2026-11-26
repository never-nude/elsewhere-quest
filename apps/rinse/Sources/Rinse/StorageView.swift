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
                sectionTitle("New in the last week",
                             "Rinse has no earlier look to compare with yet, so this counts files created or changed in the past 7 days. From tomorrow it can say exactly what grew.")
                let recent = survey.entries.filter { $0.recentBytes >= 100_000_000 }.sorted { $0.recentBytes > $1.recentBytes }
                if recent.isEmpty {
                    Text("Less than 100 MB of new files anywhere.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(recent.prefix(8)) { entry in
                        ChangeRow(title: entry.place.title, delta: entry.recentBytes, total: entry.bytes,
                                  place: entry.place, expanded: $expanded)
                    }
                }
            }
            if !survey.recentFiles.isEmpty {
                Text("Big files from the last week")
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, 6)
                ForEach(survey.recentFiles.prefix(10)) { file in
                    HStack(spacing: 10) {
                        Image(nsImage: NSWorkspace.shared.icon(forFile: file.url.path))
                            .resizable()
                            .frame(width: 20, height: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(file.url.lastPathComponent)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text("\(survey.entry(file.placeID)?.place.title ?? "") · \(file.changed.formatted(.relative(presentation: .named)))")
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
        let shown = survey.entries.filter { $0.bytes >= 50_000_000 }
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
                        Text("macOS itself, apps in Applications, other users, Time Machine snapshots and swap. Finder calls most of this System Data.")
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

    private func footnote(_ survey: Survey) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Measured \(survey.measuredAt.formatted(.relative(presentation: .named))).")
            if survey.unreadable > 0 {
                Text("\(survey.unreadable) folders could not be read (macOS privacy protection). Giving Rinse Full Disk Access in System Settings › Privacy & Security lets it count them.")
            }
            if survey.incomplete {
                Text("The home folder is very large; Rinse stopped counting early, so totals are lower than they really are.")
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
                        if entry.recentBytes >= 100_000_000 {
                            Text("+\(ByteFormat.string(entry.recentBytes)) this week")
                                .font(.caption)
                                .foregroundStyle(Color.orange)
                        }
                        Spacer()
                        Text(ByteFormat.string(entry.bytes))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
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
            Text("Each snapshot keeps files you have since deleted or changed, so space you free does not come back until it goes. They pile up when the backup disk cannot be reached, and macOS removes them on its own when space runs low or after 24 hours once a backup succeeds. Their size shows up as System Data, not in your home folder.")
                .fixedSize(horizontal: false, vertical: true)
            Text("To clear them now, connect the backup disk and let a backup finish, or in Terminal run:  tmutil thinlocalsnapshots / 999999999999 4")
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.callout)
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }
}
