import Foundation

/// What the owner chose to do with each item, on top of Rinse's recommendations.
///
/// An item is **selected** when something will happen to it (washed or filed) and not selected when it
/// is left. Its **action** says which. Untouched items follow the recommendation. A choice is remembered
/// against the recommendation it overruled: if a later look recommends something else for that item,
/// the choice no longer applies, because the owner never saw the new reason.
public struct Selection: Equatable, Sendable {
    private struct Choice: Equatable, Sendable {
        let action: Verdict
        let against: Verdict
    }

    private var choices: [String: Choice] = [:]

    public init() {}

    /// What will happen to the item.
    public func action(for finding: Finding) -> Verdict {
        guard let choice = choices[finding.id], choice.against == finding.verdict else { return finding.verdict }
        return choice.action
    }

    public func isSelected(_ finding: Finding) -> Bool { action(for: finding) != .leave }

    /// True when the owner changed this item from what Rinse recommended.
    public func isOverruled(_ finding: Finding) -> Bool { action(for: finding) != finding.verdict }

    public mutating func set(_ finding: Finding, to action: Verdict) {
        // Caches, copies and the like are never filed: there is nothing of the owner's in them to keep.
        let action = action == .file && !finding.category.canBeFiled ? .wash : action
        choices[finding.id] = action == finding.verdict ? nil : Choice(action: action, against: finding.verdict)
    }

    public mutating func set(_ findings: [Finding], to action: Verdict) {
        for finding in findings { set(finding, to: action) }
    }

    /// What selecting an item does when it was not selected: its recommendation if that was to act,
    /// otherwise file it (keeping it) where that is possible, and wash it where it is not.
    public static func actionWhenSelected(_ finding: Finding) -> Verdict {
        if finding.verdict != .leave { return finding.verdict }
        return finding.category.canBeFiled ? .file : .wash
    }

    public mutating func select(_ finding: Finding) {
        guard !isSelected(finding) else { return }
        set(finding, to: Self.actionWhenSelected(finding))
    }

    public mutating func deselect(_ finding: Finding) { set(finding, to: .leave) }

    public mutating func toggle(_ finding: Finding) {
        if isSelected(finding) { deselect(finding) } else { select(finding) }
    }

    public mutating func select(_ findings: [Finding]) { for finding in findings { select(finding) } }

    public mutating func deselect(_ findings: [Finding]) { for finding in findings { deselect(finding) } }

    /// Toggles a group: selects every item unless every item already is, in which case clears them all.
    public mutating func toggle(_ findings: [Finding]) {
        if state(of: findings) == .all { deselect(findings) } else { select(findings) }
    }

    /// Forgets every choice: everything goes back to what Rinse recommends.
    public mutating func reset() { choices = [:] }

    public mutating func reset(_ findings: [Finding]) {
        for finding in findings { choices[finding.id] = nil }
    }

    public enum GroupState: Equatable, Sendable { case none, some, all }

    public func state(of findings: [Finding]) -> GroupState {
        let selected = findings.filter(isSelected).count
        if selected == 0 { return .none }
        return selected == findings.count ? .all : .some
    }

    /// Keeps only the choices that still apply after a new look: the item is still listed and still
    /// recommended the way it was when the owner chose.
    public mutating func reconcile(with findings: [Finding]) {
        let current = Dictionary(findings.map { ($0.id, $0.verdict) }, uniquingKeysWith: { a, _ in a })
        choices = choices.filter { current[$0.key] == $0.value.against }
    }

    /// Forgets the choices for items that are gone (washed, filed or hidden).
    public mutating func forget(_ ids: Set<String>) {
        for id in ids { choices[id] = nil }
    }

    public var hasChoices: Bool { !choices.isEmpty }
}
