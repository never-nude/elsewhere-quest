import Foundation

/// A plain-words summary of one item: what Rinse thinks, why, and what pressing the button would do.
/// Shown when the pointer rests on a row.
public struct Explanation: Equatable, Sendable {
    public let headline: String
    /// Why Rinse thinks so.
    public let why: [String]
    /// What keeps it safe, and when it would be ready if it is not.
    public let notes: [String]
    /// What happens to it when the button is pressed, given what is selected now.
    public let outcome: String
}

extension Finding {
    /// - Parameters:
    ///   - action: what will happen to it now (the recommendation, or the owner's choice).
    ///   - home: the home folder, to show places as "Documents/Taxes" rather than full paths.
    ///   - archive: the filing folder, to say where a filed item would go.
    public func explanation(action: Verdict, home: URL, archive: URL) -> Explanation {
        let headline: String
        switch verdict {
        case .wash: headline = category == .redundant ? "Ready for the Trash: there is another copy" : "Ready for the Trash"
        case .file: headline = "Ready to file away"
        case .leave: headline = assessment.readyInDays == nil ? "Rinse would leave this" : "Not ready yet"
        }

        let why = assessment.reasons.map { $0.prefix(1).uppercased() + $0.dropFirst() }

        var notes: [String] = []
        if verdict != .leave {
            notes.append("Rinse is \(assessment.confidence)% sure.")
        }
        if let days = assessment.readyInDays, verdict == .leave {
            notes.append(days == 1 ? "Ready tomorrow if nothing touches it."
                                   : "Ready in \(days) days if nothing touches it.")
        }
        if let copy = keeps {
            notes.append("The copy that stays: \(Scanner.placeName(copy, home: home)).")
            notes.append("Just before anything moves, Rinse checks again that it is still there and still the same.")
        }
        if !category.canBeFiled {
            notes.append("This kind is never filed: \(category == .redundant ? "the other copy is the one to keep" : "nothing in it is yours to keep").")
        }

        let outcome: String
        switch action {
        case .wash:
            outcome = "Selected: it goes to the Trash. You can put it back from there until the Trash is emptied."
        case .file:
            let folder = Filer.folder(for: self, home: home, archive: archive)
            outcome = "Selected: it moves to \(Scanner.placeName(folder, home: home))."
        case .leave:
            outcome = "Not selected: it stays where it is."
        }
        return Explanation(headline: headline, why: why, notes: notes, outcome: outcome)
    }
}
