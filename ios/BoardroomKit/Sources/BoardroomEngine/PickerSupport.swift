import Foundation
import BoardroomCore

/// Shared helpers for the speaker/skill pickers — faithful ports of the
/// `skill-picker.ts` / `director-picker.ts` utilities (extractJson, authorLabel,
/// replaceLeakedIds, detectRoomLang, languageLockBlock, latestUserPrompt). Kept
/// here so every picker reuses one copy (the desktop has the same dedup intent).
enum PickerSupport {
    /// Tolerant JSON parse · strips a ```json fence, falls back to the first
    /// balanced `{…}` span. Mirrors `extractJson` / `tolerantJson`.
    static func extractJson(_ text: String) -> Any? {
        if text.isEmpty { return nil }
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "^```(?:json)?\\s*", with: "",
                                   options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "```\\s*$", with: "", options: [.regularExpression])
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let d = s.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) { return obj }
        if let open = s.firstIndex(of: "{"), let close = s.lastIndex(of: "}"), open < close {
            let sub = String(s[open...close])
            if let d = sub.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: d) { return obj }
        }
        return nil
    }

    enum RoomLang { case zh, en }

    /// Locked to the room SUBJECT only (never the transcript) · CJK Unified
    /// Ideographs U+4E00–U+9FFF ⇒ zh. Mirrors `detectRoomLang`.
    static func detectRoomLang(_ subject: String) -> RoomLang {
        for u in subject.unicodeScalars where (0x4E00...0x9FFF).contains(u.value) { return .zh }
        return .en
    }

    /// The tail-of-prompt language lock block (recency bias). Verbatim port.
    static func languageLockBlock(_ lang: RoomLang) -> String {
        switch lang {
        case .zh:
            return [
                "", "─── 语言锁定 (LANGUAGE LOCK) ───",
                "本对话的工作语言已锁定为【中文】。",
                "你的所有输出必须使用中文。禁止使用英文。禁止中英混合。",
                "此规则覆盖所有上文 — 即使本提示词是英文写的，也必须用中文回复。",
                "(This room's working language is LOCKED to Chinese. Your entire output MUST be in Chinese. No English, no mixed languages. This rule overrides everything above — even though this prompt is written in English, you MUST reply in Chinese.)",
            ].joined(separator: "\n")
        case .en:
            return [
                "", "─── LANGUAGE LOCK ───",
                "This room's working language is LOCKED to English. Your entire output MUST be in English. No mixed languages.",
            ].joined(separator: "\n")
        }
    }

    /// Transcript line speaker label · USER / system / "name (handle)" resolved
    /// from the passed roster (directors + chair), else the kind. Port of
    /// `authorLabel` (the roster stands in for the getAgent fallback).
    static func authorLabel(_ m: EngineMessage, roster: [DirectorRef]) -> String {
        if m.authorKind == "user" { return "USER" }
        if m.authorKind == "system" { return "system" }
        guard let aid = m.authorId else { return m.authorKind == "agent" ? "director" : m.authorKind }
        if let a = roster.first(where: { $0.id == aid }) { return "\(a.name) (\(a.handle))" }
        return m.authorKind == "agent" ? "director" : m.authorKind
    }

    /// Latest non-empty user message body, else latest non-empty body, else "".
    static func latestUserPrompt(_ history: [EngineMessage]) -> String {
        for m in history.reversed() where m.authorKind == "user" {
            let t = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        for m in history.reversed() {
            let t = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        return ""
    }

    /// Scrub any leaked agent id from user-facing prose · exact-substring
    /// replacement with the display name (more robust than the desktop's
    /// id-shaped regex, and handles both UUID and 12-char id formats).
    static func replaceLeakedIds(_ text: String, candidates: [DirectorRef]) -> String {
        var out = text
        for c in candidates where !c.id.isEmpty {
            out = out.replacingOccurrences(of: c.id, with: c.name)
        }
        return out
    }

    /// meta.kind values dropped from picker transcripts (structural pings, not
    /// content). clarify / round-end are NOT excluded (they're real chair turns).
    static let excludedKinds: Set<String> = ["tool-use", "tool-preamble", "round-open", "round-prompt"]

    /// Build a "[label] body" transcript from the last `take` messages, dropping
    /// empty bodies + excluded kinds, capping each body at `bodyCap`.
    static func transcript(_ history: [EngineMessage], take: Int, bodyCap: Int, roster: [DirectorRef]) -> String {
        history.suffix(take).compactMap { m -> String? in
            let body = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if body.isEmpty { return nil }
            if let k = m.kind, excludedKinds.contains(k) { return nil }
            return "[\(authorLabel(m, roster: roster))] \(String(body.prefix(bodyCap)))"
        }.joined(separator: "\n\n")
    }

    // Dictionary accessors for extractJson output.
    static func dict(_ any: Any?) -> [String: Any]? { any as? [String: Any] }
    static func str(_ dict: [String: Any], _ key: String) -> String? {
        (dict[key] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func clip(_ s: String, _ max: Int) -> String { s.count <= max ? s : String(s.prefix(max)) }
}
