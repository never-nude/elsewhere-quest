import AppKit
import RinseCore
import SwiftUI

/// The rinse itself: look over what was found, then wash.
struct ReviewView: View {
    @Environment(AppModel.self) private var model
    @State private var collapsed: Set<Residue> = []

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(minWidth: 560, minHeight: 480)
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

    private func list(_ result: ScanResult) -> some View {
        List {
            ForEach(result.categories) { category in
                Section {
                    if !collapsed.contains(category) {
                        ForEach(result.findings(in: category)) { finding in
                            FindingRow(finding: finding)
                        }
                    }
                } header: {
                    categoryHeader(category, result: result)
                }
            }
        }
        .listStyle(.inset)
        .disabled(model.phase == .washing)
    }

    private func categoryHeader(_ category: Residue, result: ScanResult) -> some View {
        HStack(spacing: 10) {
            Button {
                model.toggle(category)
            } label: {
                Image(systemName: markSymbol(model.mark(for: category)))
                    .font(.system(size: 15))
                    .foregroundStyle(model.mark(for: category) == .none ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.water))
            }
            .buttonStyle(.plain)
            .help("Check or uncheck all of these")
            Image(systemName: category.symbol)
                .frame(width: 20)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(category.title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text(category.blurb)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(ByteFormat.string(result.bytes(in: category)))
                .monospacedDigit()
                .foregroundStyle(.secondary)
            Button {
                if collapsed.contains(category) { collapsed.remove(category) } else { collapsed.insert(category) }
            } label: {
                Image(systemName: collapsed.contains(category) ? "chevron.right" : "chevron.down")
                    .frame(width: 16)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func markSymbol(_ mark: Mark) -> String {
        switch mark {
        case .none: return "square"
        case .some: return "minus.square.fill"
        case .all: return "checkmark.square.fill"
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 12) {
            if model.phase == .clean {
                Spacer()
                Button("Done") {
                    model.finishWash()
                    ReviewWindow.shared.close()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(model.selectedFindings.count) checked")
                    Text("Everything goes to the Trash, so you can still put it back.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if model.phase == .washing {
                    ProgressView().controlSize(.small)
                }
                Button(model.hasResidue ? "Wash Off \(ByteFormat.string(model.selectedBytes))" : "Nothing Checked") {
                    Task { await model.wash() }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
                .disabled(model.selectedFindings.isEmpty || model.phase == .washing)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}

private struct FindingRow: View {
    @Environment(AppModel.self) private var model
    let finding: Finding

    var body: some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(
                get: { model.isSelected(finding) },
                set: { model.setSelected(finding, $0) }))
                .toggleStyle(.checkbox)
                .labelsHidden()
            Image(nsImage: NSWorkspace.shared.icon(forFile: finding.url.path))
                .resizable()
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 1) {
                Text(finding.name)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(finding.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(ByteFormat.string(finding.bytes))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .help(finding.url.path)
        .contextMenu {
            Button("Show in Finder") {
                NSWorkspace.shared.activateFileViewerSelecting([finding.url])
            }
            Button("Open") {
                NSWorkspace.shared.open(finding.url)
            }
            Divider()
            Button("Never Show This Again") {
                model.ignore(finding)
            }
        }
    }
}

/// After the wash: what went, what would not, and the option to make it final.
private struct CleanView: View {
    let report: WashReport
    @State private var trashMessage: String?
    @State private var confirmingEmpty = false

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "drop.fill")
                .font(.system(size: 56))
                .foregroundStyle(.waterGradient)
            Text(report.washed.isEmpty ? "Nothing moved" : "\(ByteFormat.string(report.bytes)) washed off")
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
            if !report.washed.isEmpty {
                Button("Empty the Trash…") {
                    confirmingEmpty = true
                }
                .padding(.top, 6)
            }
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

    private var caption: String {
        if report.washed.isEmpty { return "None of the checked items could be moved." }
        let count = report.washed.count
        return "\(count) \(count == 1 ? "item is" : "items are") in the Trash.\nThe space comes back when the Trash is emptied."
    }
}
