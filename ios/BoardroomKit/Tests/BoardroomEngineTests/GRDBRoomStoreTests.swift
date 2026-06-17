import XCTest
import GRDB
import BoardroomAI
import BoardroomStorage
@testable import BoardroomEngine

/// End-to-end: a real `RoomActor` driving the GRDB-backed store over a real
/// (temp, fully-migrated) `BoardroomDB`, with the scripted-LLM stub. Proves the
/// orchestration → persistence bridge without any network.
final class GRDBRoomStoreTests: XCTestCase {
    private func freshDB() throws -> BoardroomDB {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try BoardroomDB(path: dir.appendingPathComponent("t.sqlite").path)
    }

    /// Records the system prompt of each LLM call by purpose, then replies with
    /// canned text (instant stream).
    final class CapturingLLM: EngineLLM, @unchecked Sendable {
        private let lock = NSLock()
        private var systems: [LLMPurpose: [String]] = [:]
        let clarify: String, director: String, roundEnd: String
        init(clarify: String, director: String, roundEnd: String) {
            self.clarify = clarify; self.director = director; self.roundEnd = roundEnd
        }
        func firstSystem(for p: LLMPurpose) -> String? { lock.lock(); defer { lock.unlock() }; return systems[p]?.first }
        func stream(_ messages: [LLMMessage], modelV: String, maxTokens: Int?, purpose: LLMPurpose)
            -> AsyncThrowingStream<LLMStreamChunk, Error> {
            let sys = messages.first { $0.role == .system }?.content ?? ""
            lock.lock(); systems[purpose, default: []].append(sys); lock.unlock()
            let text = purpose == .clarify ? clarify : purpose == .director ? director : roundEnd
            return AsyncThrowingStream { c in c.yield(.textDelta(text)); c.yield(.done(finishReason: "stop")); c.finish() }
        }
    }

    private func seed(_ db: BoardroomDB) throws {
        try db.pool.write { conn in
            func agent(_ id: String, _ name: String, _ role: String, _ model: String) throws {
                try conn.execute(sql: """
                    INSERT INTO agents (id, name, handle, instruction, model_v, avatar_path, role_kind, created_at, updated_at)
                    VALUES (?, ?, ?, 'inst', ?, '/a.png', ?, 1, 1)
                    """, arguments: [id, name, "@\(id)", model, role])
            }
            try agent("chair", "Chair", "moderator", "haiku-4-5")
            try agent("d1", "Alice", "director", "opus-4-7")
            try agent("d2", "Bob", "director", "sonnet-4-6")
            try conn.execute(sql: """
                INSERT INTO rooms (id, number, name, subject, created_at) VALUES ('r1', 1, 'Room', 'subject?', 1)
                """)
            try conn.execute(sql: "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES ('r1','d1',0,1),('r1','d2',1,1)")
        }
    }

    func testStoreLookups() async throws {
        let db = try freshDB(); try seed(db)
        let store = GRDBRoomStore(db: db)
        let dirs = await store.directors("r1")
        XCTAssertEqual(dirs.map(\.id), ["d1", "d2"])
        XCTAssertEqual(dirs[0].modelV, "opus-4-7")
        let chair = await store.chair("r1")
        XCTAssertEqual(chair?.id, "chair")
        let rn = await store.nextRoundNum("r1")
        XCTAssertEqual(rn, 1)   // no messages yet
    }

    func testFullRoundPersists() async throws {
        let db = try freshDB(); try seed(db)
        let store = GRDBRoomStore(db: db)
        let llm = ScriptedLLM(clarify: ["READY"], director: ["my view"], roundEnd: ["wrap\nPOINTS:\n- alpha\n- beta"])
        let engine = Engine(store: store, llm: llm)

        await engine.convene("r1")   // READY → opening round (2 dirs) → round-ended

        try await db.pool.read { conn in
            // Messages persisted: 1 chair clarify + 2 directors + 1 chair round-end = 4 agent rows.
            let agentMsgs = try Int.fetchOne(conn, sql: "SELECT count(*) FROM messages WHERE author_kind='agent'") ?? 0
            XCTAssertEqual(agentMsgs, 4)
            // No message left mid-stream (meta_json streaming flag false everywhere).
            let streaming = try Int.fetchOne(conn, sql: "SELECT count(*) FROM messages WHERE meta_json LIKE '%\"streaming\":true%'") ?? -1
            XCTAssertEqual(streaming, 0)
            // Key points persisted.
            let kps = try String.fetchAll(conn, sql: "SELECT body FROM key_points WHERE room_id='r1' ORDER BY position")
            XCTAssertEqual(kps, ["alpha", "beta"])
            // Round-end set the soft-pause flag.
            let awaitingContinue = try Int.fetchOne(conn, sql: "SELECT awaiting_continue FROM rooms WHERE id='r1'")
            XCTAssertEqual(awaitingContinue, 1)
        }
    }

    /// With room meta present (GRDB), the chair turn must use the real
    /// `ChairPromptBuilder` — not the tagged stub. Capture the messages the LLM
    /// received and assert they carry the faithful clarify prompt + room subject.
    func testChairClarifyUsesRealPromptViaGRDB() async throws {
        let db = try freshDB(); try seed(db)
        let store = GRDBRoomStore(db: db)
        let cap = CapturingLLM(clarify: "READY", director: "v", roundEnd: "w\nPOINTS:\n- a")
        let engine = Engine(store: store, llm: cap)
        await engine.convene("r1")

        let clarifySys = await cap.firstSystem(for: .clarify)
        XCTAssertNotNil(clarifySys)
        XCTAssertTrue(clarifySys!.contains("YOUR TASK · OPEN THE ROOM"))   // real builder, not "ROLE: CHAIR-CLARIFY"
        XCTAssertTrue(clarifySys!.contains("Room subject: subject?"))
        XCTAssertTrue(clarifySys!.contains("─── LANGUAGE ───"))
        // Director turn carries the verbatim SHARED_ROOM_PROTOCOL + guidance.
        let dirSys = await cap.firstSystem(for: .director)
        XCTAssertNotNil(dirSys)
        XCTAssertTrue(dirSys!.contains("─── ROOM PROTOCOL ───"))     // SHARED_ROOM_PROTOCOL
        XCTAssertTrue(dirSys!.contains("high-signal perspective"))   // protocol body
    }

    func testDirectorPromptsCatalogLoads() {
        XCTAssertNotNil(DirectorPrompts.catalog)
        XCTAssertFalse(DirectorPrompts.sharedRoomProtocol.isEmpty)
        XCTAssertFalse(DirectorPrompts.toneGuidance("brainstorm").isEmpty)
        XCTAssertEqual(DirectorPrompts.normalizeTone("no-mercy"), "debate")
        XCTAssertEqual(DirectorPrompts.normalizeIntensity("brutal"), "terse")
        XCTAssertEqual(DirectorPrompts.toneGuidance("nonsense"), DirectorPrompts.toneGuidance("constructive"))
    }

    func testKeyPointVotePersists() async throws {
        let db = try freshDB(); try seed(db)
        let store = GRDBRoomStore(db: db)
        let kps = await store.insertKeyPoints("r1", roundNum: 1, points: ["alpha", "beta"])
        let id = kps[0].id
        let engine = Engine(store: store, llm: ScriptedLLM(clarify: ["READY"], director: ["v"], roundEnd: ["w\nPOINTS:\n- a"]))
        await engine.voteKeyPoint(id, vote: "up")
        var vote = try await db.pool.read { try String.fetchOne($0, sql: "SELECT vote FROM key_points WHERE id=?", arguments: [id]) }
        XCTAssertEqual(vote, "up")
        // Toggling off (nil) clears it.
        await engine.voteKeyPoint(id, vote: nil)
        vote = try await db.pool.read { try String.fetchOne($0, sql: "SELECT vote FROM key_points WHERE id=?", arguments: [id]) }
        XCTAssertNil(vote)
    }

    func testBriefGeneratesAndPersists() async throws {
        let db = try freshDB(); try seed(db)
        let store = GRDBRoomStore(db: db)
        let md = "## Summary\nWe decided to ship native first.\n## Key Points\n- on-device wins on latency"
        let engine = Engine(store: store, llm: ScriptedLLM(clarify: ["READY"], director: ["v"], roundEnd: [md]))
        // brief uses purpose .roundEnd in the scripted stub → returns `md`.
        let out = try await engine.generateBrief("r1")
        XCTAssertTrue(out.contains("ship native first"))
        // Persisted + retrievable.
        let latest = await engine.latestBriefMarkdown("r1")
        XCTAssertEqual(latest, md)
        let count = try await db.pool.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM briefs WHERE room_id='r1'") }
        XCTAssertEqual(count, 1)
        XCTAssertEqual(BriefGenerator.firstHeading(md), "Summary")
    }

    /// Stub TTS · one segment with fake audio per turn.
    struct StubTTS: EngineTTS {
        func synthesizeStream(_ text: String, agentId: String) -> AsyncStream<(seg: Int, text: String, audioBase64: String)> {
            AsyncStream { continuation in
                continuation.yield((seg: 0, text: text, audioBase64: "AAAA"))
                continuation.finish()
            }
        }
    }

    func testVoiceRoomEmitsAudioAndSerializesViaGate() async throws {
        let db = try freshDB(); try seed(db)
        // Flip the room to voice delivery.
        try await db.pool.write { try $0.execute(sql: "UPDATE rooms SET delivery_mode='voice' WHERE id='r1'") }
        let store = GRDBRoomStore(db: db)
        let bus = EventBus()
        let engine = Engine(store: store,
                            llm: ScriptedLLM(clarify: ["READY"], director: ["my view"], roundEnd: ["w\nPOINTS:\n- a"]),
                            tts: StubTTS(), bus: bus)
        // Simulate the native VoicePlayer: signal the gate when each turn's audio
        // is "done" (on voice-final) so the pump advances without the 90s timeout.
        let consumer = Task {
            for await s in await bus.subscribe("r1") {
                if case .voiceFinal(let v) = s.event { await engine.voiceDone("r1", v.messageId) }
            }
        }
        await engine.convene("r1")   // clarify READY → 2 directors (voice, gated) → round-ended
        consumer.cancel()

        let events = await bus.snapshot("r1")
        let chunks = events.filter { if case .voiceChunk = $0 { return true } else { return false } }.count
        let finals = events.filter { if case .voiceFinal = $0 { return true } else { return false } }.count
        XCTAssertGreaterThanOrEqual(chunks, 2, "each voiced turn emits a voice-chunk")
        XCTAssertGreaterThanOrEqual(finals, 2, "each voiced turn emits a voice-final")
        // The gate didn't deadlock: the round reached its end after both directors.
        let kinds = events.compactMap { e -> String? in if case .configEvent(let c) = e { return c.kind } else { return nil } }
        XCTAssertTrue(kinds.contains("round-ended"))
    }

    func testAdjournPersistsStatus() async throws {
        let db = try freshDB(); try seed(db)
        let store = GRDBRoomStore(db: db)
        let engine = Engine(store: store, llm: ScriptedLLM(clarify: ["READY"], director: ["v"], roundEnd: ["w\nPOINTS:\n- a"]))
        await engine.convene("r1")
        await engine.adjourn("r1")
        let status = try await db.pool.read { try String.fetchOne($0, sql: "SELECT status FROM rooms WHERE id='r1'") }
        XCTAssertEqual(status, "adjourned")
    }
}
