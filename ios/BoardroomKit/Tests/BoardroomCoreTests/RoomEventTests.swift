import XCTest
@testable import BoardroomCore

final class RoomEventTests: XCTestCase {
    private func ev(_ name: String, _ json: String) -> RoomEvent? {
        RoomEvent.parse(name: name, data: Data(json.utf8))
    }

    func testMessageAppendedDecodes() {
        guard case .messageAppended(let d)? = ev("message-appended",
            #"{"messageId":"m1","body":"hi","authorId":"a1","authorKind":"agent","roundNum":2,"meta":{"kind":"clarify"}}"#)
        else { return XCTFail("expected .messageAppended") }
        XCTAssertEqual(d.messageId, "m1")
        XCTAssertEqual(d.authorKind, "agent")
        XCTAssertEqual(d.roundNum, 2)
        XCTAssertEqual(d.meta?.kind, "clarify")
    }

    func testMessageTokenDecodes() {
        guard case .messageToken(let d)? = ev("message-token", #"{"messageId":"m1","delta":"abc"}"#)
        else { return XCTFail("expected .messageToken") }
        XCTAssertEqual(d.delta, "abc")
    }

    func testVoiceChunkDecodes() {
        guard case .voiceChunk(let d)? = ev("voice-chunk",
            #"{"messageId":"m1","audioBase64":"AAAA","mimeType":"audio/mpeg","seq":3,"seg":1,"text":"a sentence"}"#)
        else { return XCTFail("expected .voiceChunk") }
        XCTAssertEqual(d.seg, 1)
        XCTAssertEqual(d.text, "a sentence")
    }

    func testVoiceErrorMapsToVoiceErrorCase() {
        guard case .voiceError(let d)? = ev("voice-error", #"{"messageId":"m9","code":"billing"}"#)
        else { return XCTFail("expected .voiceError") }
        XCTAssertEqual(d.messageId, "m9")
    }

    func testConfigEventRoundEnded() {
        guard case .configEvent(let d)? = ev("config-event",
            #"{"kind":"settings-changed","payload":{"changes":{"mode":{"from":"debate","to":"constructive"}}}}"#)
        else { return XCTFail("expected .configEvent") }
        XCTAssertEqual(d.kind, "settings-changed")
        XCTAssertEqual(d.payload?.changes?.mode?.to, "constructive")
    }

    func testMessageErrorAlwaysProduced() {
        // message-error must produce the case even with an empty/odd payload
        // (the client drops the thinking cue + clears the stage regardless).
        guard case .messageError(let mid, _, _)? = ev("message-error", #"{"messageId":"m1","message":"boom"}"#)
        else { return XCTFail("expected .messageError") }
        XCTAssertEqual(mid, "m1")
        guard case .messageError? = ev("message-error", #"{}"#)
        else { return XCTFail("expected .messageError on empty payload") }
    }

    func testKnownEventWithBadPayloadReturnsNil() {
        // A known event whose required field is missing → nil (silently skipped).
        XCTAssertNil(ev("message-appended", #"{"body":"no id"}"#))
    }

    func testUnknownEventName() {
        guard case .unknown(let name)? = ev("brief-token", #"{}"#)
        else { return XCTFail("expected .unknown") }
        XCTAssertEqual(name, "brief-token")
    }
}
