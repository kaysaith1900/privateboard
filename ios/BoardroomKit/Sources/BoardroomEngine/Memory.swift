import Foundation
import BoardroomCore
import BoardroomAI

/// Memory extraction at adjourn (`memory.ts` `extractMemoriesAfterAdjourn`). Each
/// participating agent (chair + directors) re-reads the adjourned room through
/// ITS OWN lens and extracts 0–3 durable notes about the user, using the agent's
/// own model (not the utility tier). Fire-and-forget; per-agent failures are
/// swallowed. Followed by a heuristic decay sweep so memory doesn't grow
/// unbounded. (The full dream metabolism — cluster/merge/conflict/promote/
/// user-long harvest — is the remaining depth of P4-7.)
public enum Memory {
    static let allowedKinds: Set<String> = ["fact", "observation", "preference", "goal"]
    struct Note { let content: String; let kind: String; let confidence: Double }

    public static func extractAfterAdjourn(router: EngineRouter, store: RoomStore,
                                           mem: MemoryStore, roomId: String) async {
        let directors = await store.directors(roomId)
        let chair = await store.chair(roomId)
        let agents = (chair.map { [$0] } ?? []) + directors
        guard !agents.isEmpty else { return }
        let history = await store.recentMessages(roomId, limit: 60)
        guard !history.isEmpty else { return }
        let userName = (await store.roomMeta(roomId))?.userName ?? "the user"
        let transcript = buildTranscript(history, agents: agents, userName: userName)
        for agent in agents {
            let notes = await runExtraction(router: router, agent: agent, transcript: transcript, userName: userName)
            for n in notes {
                await mem.insertMemory(agentId: agent.id, content: n.content, kind: n.kind,
                                       sourceRoom: roomId, confidence: n.confidence)
            }
            await mem.decayShortTermMemories(agentId: agent.id)
        }
        // Memory metabolism (P4-7b) · bump each agent's adjourn counter; when it
        // crosses the trigger threshold (director 5 / chair 3) run a dream cycle
        // (cluster → merge → conflict-resolve → promote) fire-and-forget.
        let chairId = chair?.id
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        // Optional sub-seams (GRDBRoomStore conforms; stub stores → nil → skipped).
        let ulRef = mem as? UserLongMemoryStore
        let auditRef = mem as? DreamAuditStore
        for agent in agents {
            let isChair = agent.id == chairId
            if await DreamCounter.shared.bump(agentId: agent.id, isChair: isChair) {
                await DreamCounter.shared.reset(agentId: agent.id)
                let memRef = mem, routerRef = router, aid = agent.id, uname = userName, chairFlag = isChair
                Task {
                    await Dream.runCycle(router: routerRef, store: memRef, agentId: aid, isChair: chairFlag,
                                         userName: uname, nowMs: nowMs, userLong: ulRef, audit: auditRef)
                }
            }
        }
    }

    /// One shared transcript view (all agents see the same record).
    static func buildTranscript(_ history: [EngineMessage], agents: [DirectorRef], userName: String) -> String {
        var names: [String: String] = [:]
        for a in agents { names[a.id] = "\(a.name) · \(a.handle)" }
        return history.compactMap { m -> String? in
            let body = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if body.isEmpty { return nil }
            switch m.authorKind {
            case "user": return "[\(userName)] \(body)"
            case "system": return "[system] \(body)"
            default:
                let label = m.authorId.flatMap { names[$0] } ?? "Director"
                return "[\(label)] \(body)"
            }
        }.joined(separator: "\n\n")
    }

    static func runExtraction(router: EngineRouter, agent: DirectorRef, transcript: String, userName: String) async -> [Note] {
        let role = agent.bio.isEmpty ? (agent.roleTag.isEmpty ? "(no description)" : agent.roleTag) : agent.bio
        let system = """
You are \(agent.name) (\(agent.handle)), a director participating in a multi-agent boardroom.

Your role description:
\(role)

─── YOUR TASK · MEMORY EXTRACTION ───
The room you just participated in has just adjourned. Your job NOW is purely meta — extract 0 to 3 things about \(userName) that are worth REMEMBERING for FUTURE rooms.

What counts:
· Stable facts about \(userName) (occupation, project, expertise, language preference, recurring constraints).
· Reading-of-the-user observations through YOUR specific lens (different agents notice different things).
· Stated preferences (how they like to think, format, push back).
· Stated goals with concrete horizons.

What does NOT count (do NOT extract):
· Anything about the discussion topic itself or what the directors said.
· Generic platitudes ("the user is thoughtful").
· Things the user just told \(agent.name) once that aren't generalisable.
· Anything you only inferred — only assert what the transcript supports.

Output STRICT format · one JSON line per note. NO prose, NO markdown, NO code fence. If nothing is worth remembering, output the literal token NONE on a single line.

Each line:
{"content": "first-person sentence about \(userName)", "kind": "fact|observation|preference|goal", "confidence": 0.0-1.0}

Examples (English):
{"content": "\(userName) is a cofounder building an HR SaaS focused on resume screening", "kind": "fact", "confidence": 0.9}
{"content": "\(userName) struggles to define load-bearing terms before reasoning", "kind": "observation", "confidence": 0.7}

Examples (Chinese · use Chinese when the room was conducted in Chinese):
{"content": "\(userName) 是一家 HR SaaS 的 cofounder，主要做简历筛选自动化", "kind": "fact", "confidence": 0.9}

Hard rules:
· Output ONLY JSON lines OR the literal token NONE. Nothing else.
· Maximum 3 notes. Often 0 is correct.
· Match the language the room was conducted in.
· Use first-person assertions about \(userName), not "the user".
"""
        let user = """
─── ROOM TRANSCRIPT (just adjourned) ───
\(transcript.isEmpty ? "(empty room — nothing to extract)" : transcript)

─── YOUR EXTRACTION ───
0–3 JSON-line notes about \(userName) from your lens, OR the literal token NONE.
"""
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: system), LLMMessage(role: .user, content: user)],
            modelV: agent.modelV, temperature: 0.2, maxTokens: 600) else { return [] }
        return parseExtractionOutput(raw)
    }

    static func parseExtractionOutput(_ raw: String) -> [Note] {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "^```(?:json)?\\s*", with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "```\\s*$", with: "", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return [] }
        if s.range(of: "^\\s*NONE\\s*$", options: [.regularExpression, .caseInsensitive]) != nil { return [] }
        var notes: [Note] = []
        for line in s.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty || !t.hasPrefix("{") { continue }
            guard let d = t.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            let content = (obj["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if content.isEmpty || content.count > 280 { continue }
            let kindRaw = (obj["kind"] as? String) ?? "fact"
            let kind = allowedKinds.contains(kindRaw) ? kindRaw : "fact"
            var confidence = 0.7
            if let c = obj["confidence"] as? Double, c.isFinite { confidence = max(0, min(1, c)) }
            else if let c = (obj["confidence"] as? NSNumber)?.doubleValue, c.isFinite { confidence = max(0, min(1, c)) }
            notes.append(Note(content: content, kind: kind, confidence: confidence))
            if notes.count >= 3 { break }
        }
        return notes
    }
}
