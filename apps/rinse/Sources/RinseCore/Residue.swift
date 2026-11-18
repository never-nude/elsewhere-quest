import Foundation

/// The kinds of residue Rinse looks for, in the order they are shown.
public enum Residue: String, CaseIterable, Codable, Sendable, Identifiable {
    case screenshots
    case recordings
    case installers
    case caches
    case developer
    case staleDownloads
    case bigIdle

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .screenshots: return "Screenshots"
        case .recordings: return "Screen recordings"
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
        case .installers: return "shippingbox"
        case .caches: return "internaldrive"
        case .developer: return "hammer"
        case .staleDownloads: return "arrow.down.circle"
        case .bigIdle: return "moon.zzz"
        }
    }
}
