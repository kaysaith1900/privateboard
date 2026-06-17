import Foundation

enum RelativeTime {
    /// Compact "now / 5m / 3h / 2d / Mar 4" label, matching the web list feel.
    static func short(_ date: Date?) -> String {
        guard let date else { return "" }
        let secs = Date().timeIntervalSince(date)
        if secs < 45 { return "now" }
        let mins = Int(secs / 60)
        if mins < 60 { return "\(mins)m" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs)h" }
        let days = hrs / 24
        if days < 7 { return "\(days)d" }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }
}
