import Foundation

/// The kinds of residue Rinse looks for, in the order they are shown.
public enum Residue: String, CaseIterable, Codable, Sendable, Identifiable {
    case screenshots
    case recordings
    case redundant
    case installers
    case caches
    case developer
    case projectBuilds
    case staleDownloads
    case bigIdle

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .screenshots: return "Screenshots"
        case .recordings: return "Screen recordings"
        case .redundant: return "Redundant copies"
        case .projectBuilds: return "Project build folders"
        case .installers: return "Installers"
        case .caches: return "App caches"
        case .developer: return "Developer leftovers"
        case .staleDownloads: return "Stale downloads"
        case .bigIdle: return "Big and idle"
        }
    }

    public var blurb: String {
        switch self {
        case .screenshots: return "Captures that served their moment"
        case .recordings: return "Screen recordings left where they landed"
        case .redundant: return "Unpacked archives, duplicates, old builds and spent installers"
        case .projectBuilds: return "Dependencies and build output a project can recreate"
        case .installers: return "Disk images and packages you have already run"
        case .caches: return "Apps rebuild these when they need them"
        case .developer: return "Build products and tool caches that regenerate"
        case .staleDownloads: return "Downloads nobody has touched in a while"
        case .bigIdle: return "Large files that have been sitting untouched"
        }
    }

    /// SF Symbol name.
    public var symbol: String {
        switch self {
        case .screenshots: return "camera.viewfinder"
        case .recordings: return "record.circle"
        case .redundant: return "square.on.square"
        case .projectBuilds: return "shippingbox.and.arrow.backward"
        case .installers: return "shippingbox"
        case .caches: return "internaldrive"
        case .developer: return "hammer"
        case .staleDownloads: return "arrow.down.circle"
        case .bigIdle: return "moon.zzz"
        }
    }

    /// Things that rebuild themselves, or that have another copy, are washed or left, never filed.
    public var canBeFiled: Bool {
        switch self {
        case .caches, .developer, .redundant, .projectBuilds: return false
        default: return true
        }
    }
}
