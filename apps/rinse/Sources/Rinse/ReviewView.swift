import AppKit
import RinseCore
import SwiftUI

/// The rinse itself: Rinse's recommendations, the owner's corrections, then one button.
struct ReviewView: View {
    @Environment(AppModel.self) private var model
    @State private var collapsed: Set<Verdict> = [.leave]
    @State private var showingHow = false

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 620, minHeight: 480)
        .tint(.water)
        .sheet(isPresented: $model.showSettings) {
            SettingsView().environment(self.model)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "drop.fill")
                .font(.system(size: 28))
                .foregroundStyle(.waterGradient)
            VStack(alignment: .leading, spacing: 2) {
                Text(Calendar.current.component(.hour, from: Date()) >= 17 ? "Tonight's rinse" : "Today's rinse")
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                Text(summary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.isScanning {
                ProgressView().controlSize(.small)
            }
            Button {
                showingHow = true
            } label: {
                Image(systemName: "questionmark.circle")
            }
            .help("How Rinse decides")
            .popover(isPresented: $showingHow, arrowEdge: .bottom) { HowItDecides() }
            Button {
                Task { await model.scan() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Look again")
            .disabled(model.isScanning)
            Button {
                model.showSettings = true
            } label: {
                Image(systemName: "gearshape")
            }
            .help("Settings")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var summary: String {
        guard let result = model.result else { return "Checking the usual corners…" }
        if result.findings.isEmpty { return "Nothing to wash off" }
        return "\(result.findings.count) things found, \(ByteFormat.string(result.totalBytes)) in all"
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if model.phase == .clean, let report = model.lastReport {
            CleanView(report: report)
        } else if let result = model.result {
            if result.findings.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 44))
                        .foregroundStyle(.waterGradient)
                    Text("All clear")
                        .font(.system(.title, design: .rounded).weight(.semibold))
                    Text("Nothing has built up. Carry on.")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list(result)
            }
        } else {
            ProgressView("Looking around…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// One section per recommendation, so the question "what should go?" is answered by where a row sits.
    private func list(_ result: ScanResult) -> some View {
        List {
            ForEach(Verdict.allCases) { verdict in
                let rows = result.findings(recommended: verdict)
                if !rows.isEmpty {
                    Section {
                        if !collapsed.contains(verdict) {
                            ForEach(rows) { finding in
                                FindingRow(finding: finding)
                            }
                        }
                    } header: {
                        sectionHeader(verdict, rows: rows)
                    }
                }
            }
        }
        .listStyle(.inset)
        .disabled(model.phase == .working)
    }

    private func sectionHeader(_ verdict: Verdict, rows: [Finding]) -> some View {
        HStack(spacing: 10) {
            Image(systemName: verdict.symbol)
                .font(.system(size: 16))
                .frame(width: 22)
                .foregroundStyle(verdict == .leave ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.water))
            VStack(alignment: .leading, spacing: 1) {
                Text("\(verdict.title)  ·  \(rows.count)")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(verdict.blurb)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(ByteFormat.string(rows.reduce(0) { $0 + $1.bytes }))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Menu {
                Button("Wash All of These") { model.setAll(recommended: verdict, to: .wash) }
                Button("File All of These") { model.setAll(recommended: verdict, to: .file) }
                Button("Leave All of These") { model.setAll(recommended: verdict, to: .leave) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Change all of these at once")
            Button {
                if collapsed.contains(verdict) { collapsed.remove(verdict) } else { collapsed.insert(verdict) }
            } label: {
                Image(systemName: collapsed.contains(verdict) ? "chevron.right" : "chevron.down")
                    .frame(width: 16)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 12) {
            if model.phase == .clean {
                Spacer()
                Button("Done") {
                    model.finishRinse()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(model.washFindings.count) to wash  ·  \(model.fileFindings.count) to file")
                    Text("Washed items go to the Trash. Filed items move to “\(model.archive.lastPathComponent)”.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.phase == .working {
                    ProgressView().controlSize(.small)
                }
                Button(buttonTitle) {
                    Task { await model.rinse() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .disabled(!model.hasWork || model.phase == .working)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var buttonTitle: String {
        let wash = model.washFindings.count, file = model.fileFindings.count
        let amount = ByteFormat.string(model.washBytes)
        if wash > 0, file > 0 { return "Wash \(amount) and File \(file)" }
        if wash > 0 { return "Wash Off \(amount)" }
        if file > 0 { return "File Away \(file)" }
        return "Nothing Chosen"
    }
}

private struct FindingRow: View {
    @Environment(AppModel.self) private var model
    let finding: Finding

    var body: some View {
        let action = model.action(for: finding)
        HStack(spacing: 10) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: finding.url.path))
                .resizable()
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(finding.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(finding.reason.prefix(1).uppercased() + finding.reason.dropFirst())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if finding.verdict != .leave {
                Text("\(finding.assessment.confidence)%")
                    .font(.caption.monospacedDigit().weight(.medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.water.opacity(0.08 + 0.22 * Double(finding.assessment.confidence) / 100), in: Capsule())
                    .help("How sure Rinse is of its recommendation")
            }
            Text(ByteFormat.string(finding.bytes))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .frame(minWidth: 62, alignment: .trailing)
            Picker("", selection: Binding(
                get: { model.action(for: finding) },
                set: { model.setAction(finding, $0) })) {
                ForEach(Verdict.allCases.filter { $0 != .file || finding.category.canBeFiled }) { choice in
                    Image(systemName: choice.symbol).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: finding.category.canBeFiled ? 108 : 74)
            .help("Wash it, file it away, or leave it")
        }
        .padding(.vertical, 2)
        .opacity(action == .leave ? 0.6 : 1)
        .contentShape(Rectangle())
        .help(finding.url.path)
        .contextMenu {
            Button("Show in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([finding.url])
            }
            Button("Open") {
                NSWorkspace.shared.open(finding.url)
            }
            if let copy = finding.keeps {
                Button("Show the Copy That Stays") {
                    NSWorkspace.shared.activateFileViewerSelecting([copy])
                }
            }
            Divider()
            Button("Never Show This Again") {
                model.ignore(finding)
            }
        }
    }
}

/// The metric, in plain words.
private struct HowItDecides: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("How Rinse decides")
                .font(.headline)
            point("square.on.square", "Redundant",
                  "An archive already unpacked, an exact duplicate, an older build of an app, or an installer for an app you have. These can go straight away: the copy that stays is checked again just before anything moves.")
            point("folder", "Empty and dead",
                  "Folders with nothing in them, links to things that are gone, and leftovers with nothing in them.")
            Divider()
            Text("Everything else is measured two ways.")
            point("arrow.triangle.2.circlepath", "Replaceable",
                  "Could you get it again without effort? A cache rebuilds itself and an installer downloads again. A document, a photo or a folder of your files does not.")
            point("moon.zzz", "Dormant",
                  "How long since anything touched it, against the limit for its kind. A screenshot is dormant after a week; a download after a month.")
            Divider()
            point("drop.fill", "Can go", "Dormant, and there is evidence it is replaceable: it rebuilds, or it was downloaded from the web.")
            point("archivebox.fill", "File away", "Dormant, but yours: it moves to your filing folder instead of the Trash.")
            point("pause.circle", "Leave for now", "Not dormant yet, or moving it would gain nothing.")
            Text("The percentage is how sure Rinse is. You can overrule any row with the three buttons at its right.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(width: 340)
    }

    private func point(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .frame(width: 20)
                .foregroundStyle(Color.water)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).fontWeight(.medium)
                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// After the rinse: what went, what was filed, what would not move, and the option to make it final.
private struct CleanView: View {
    let report: RinseReport
    @State private var trashMessage: String?
    @State private var confirmingEmpty = false

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "drop.fill")
                .font(.system(size: 56))
                .foregroundStyle(.waterGradient)
            Text(headline)
                .font(.system(size: 30, weight: .semibold, design: .rounded))
            Text(caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if !report.failures.isEmpty {
                DisclosureGroup("\(report.failures.count) could not be moved") {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(report.failures) { failure in
                                Text("\(failure.finding.name): \(failure.message)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .frame(maxHeight: 120)
                }
                .frame(maxWidth: 420)
            }
            HStack(spacing: 10) {
                if !report.file.filed.isEmpty {
                    Button("Show Filed Items") {
                        NSWorkspace.shared.activateFileViewerSelecting(report.file.filed.prefix(50).map(\.destination))
                    }
                }
                if !report.wash.washed.isEmpty {
                    Button("Empty the Trash…") {
                        confirmingEmpty = true
                    }
                }
            }
            .padding(.top, 6)
            if let trashMessage {
                Text(trashMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .confirmationDialog("Empty the Trash?", isPresented: $confirmingEmpty) {
            Button("Empty Trash", role: .destructive) {
                trashMessage = Platform.emptyTrash() ?? "The Trash is empty. The space is yours again."
            }
        } message: {
            Text("This permanently deletes everything in the Trash, not only what Rinse put there. It cannot be undone.")
        }
    }

    private var headline: String {
        if report.didNothing { return "Nothing moved" }
        if report.wash.washed.isEmpty { return "\(report.file.filed.count) filed away" }
        return "\(ByteFormat.string(report.wash.bytes)) washed off"
    }

    private var caption: String {
        if report.didNothing { return "None of the chosen items could be moved." }
        var lines: [String] = []
        let washed = report.wash.washed.count, filed = report.file.filed.count
        if washed > 0 {
            lines.append("\(washed) \(washed == 1 ? "item is" : "items are") in the Trash. The space comes back when the Trash is emptied.")
        }
        if filed > 0 {
            lines.append("\(filed) \(filed == 1 ? "item is" : "items are") filed in “\(report.archive.lastPathComponent)”, by kind and month.")
        }
        return lines.joined(separator: "\n")
    }
}
