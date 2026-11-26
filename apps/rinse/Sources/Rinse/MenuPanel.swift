import AppKit
import RinseCore
import SwiftUI

/// What drops down from the menu bar: the pulse, at a glance.
struct MenuPanel: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if let result = model.result, !result.findings.isEmpty {
                breakdown(result)
            }
            Button {
                open()
            } label: {
                Text(model.hasWork ? "Start the Rinse" : "Look It Over")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            footer
        }
        .padding(16)
        .frame(width: 300)
        .tint(.water)
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(headline)
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                    .contentTransition(.numericText())
                Text(subhead)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: model.hasResidue ? "drop.fill" : "drop")
                .font(.system(size: 34))
                .foregroundStyle(.waterGradient)
        }
    }

    private var headline: String {
        if model.result == nil { return "Looking…" }
        return model.hasResidue ? ByteFormat.string(model.washBytes) : "All clear"
    }

    private var subhead: String {
        guard let result = model.result else { return "Checking the usual corners" }
        let filing = model.fileFindings.count
        if model.hasResidue { return filing > 0 ? "ready to wash off, \(filing) to file" : "ready to wash off" }
        if filing > 0 { return "\(filing) \(filing == 1 ? "thing" : "things") to file away" }
        if result.totalBytes > 0 { return "\(ByteFormat.string(result.totalBytes)) more if you want to dig" }
        return "Nothing to wash off"
    }

    private func breakdown(_ result: ScanResult) -> some View {
        let largest = max(1, result.categories.map(result.bytes(in:)).max() ?? 1)
        return VStack(spacing: 9) {
            ForEach(result.categories) { category in
                let bytes = result.bytes(in: category)
                VStack(spacing: 4) {
                    HStack(spacing: 8) {
                        Image(systemName: category.symbol)
                            .frame(width: 18)
                            .foregroundStyle(.secondary)
                        Text(category.title)
                        Spacer()
                        Text(ByteFormat.string(bytes))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    .font(.callout)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(.quaternary)
                            Capsule().fill(Color.water)
                                .frame(width: max(3, geo.size.width * CGFloat(bytes) / CGFloat(largest)))
                        }
                    }
                    .frame(height: 3)
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Button {
                Task { await model.scan() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Look again")
            .disabled(model.isScanning)
            Button {
                if let panel = NSApp.keyWindow, !ReviewWindow.shared.owns(panel) { panel.close() }
                model.showStorage()
            } label: {
                Image(systemName: "internaldrive")
            }
            .help("Where your space is")
            Button {
                open(settings: true)
            } label: {
                Image(systemName: "gearshape")
            }
            .help("Settings")
        }
        .buttonStyle(.borderless)
    }

    private var status: String {
        if model.isScanning { return "Looking…" }
        let streak = model.ledger.streak(asOf: Date())
        let total = ByteFormat.string(model.ledger.totalBytes)
        if streak > 1 { return "\(streak)-day streak · \(total) all time" }
        if model.ledger.totalBytes > 0 { return "\(total) washed all time" }
        return "Nothing washed yet"
    }

    private func open(settings: Bool = false) {
        // Put the drop-down away before the window comes forward.
        if let panel = NSApp.keyWindow, !ReviewWindow.shared.owns(panel) { panel.close() }
        model.openReview(settings: settings)
    }
}
