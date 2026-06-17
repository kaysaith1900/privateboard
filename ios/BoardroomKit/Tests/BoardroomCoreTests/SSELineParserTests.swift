import XCTest
@testable import BoardroomCore

final class SSELineParserTests: XCTestCase {
    func testSingleFrame() {
        var p = SSELineParser()
        let frames = p.push("event: message-token\ndata: {\"delta\":\"hi\"}\n\n")
        XCTAssertEqual(frames, [.init(event: "message-token", data: "{\"delta\":\"hi\"}", id: nil)])
    }

    func testDefaultEventName() {
        var p = SSELineParser()
        XCTAssertEqual(p.push("data: x\n\n"), [.init(event: "message", data: "x", id: nil)])
    }

    func testMultiLineDataJoined() {
        var p = SSELineParser()
        let f = p.push("data: line1\ndata: line2\n\n")
        XCTAssertEqual(f, [.init(event: "message", data: "line1\nline2", id: nil)])
    }

    func testStickyId() {
        var p = SSELineParser()
        _ = p.push("id: 7\ndata: a\n\n")
        let f = p.push("data: b\n\n")   // no new id → carries the last one
        XCTAssertEqual(f, [.init(event: "message", data: "b", id: "7")])
    }

    func testSplitAcrossChunks() {
        var p = SSELineParser()
        XCTAssertTrue(p.push("event: voice-ch").isEmpty)
        XCTAssertTrue(p.push("unk\ndata: {\"seg\":1}").isEmpty)   // frame not yet dispatched
        let f = p.push("\n\n")
        XCTAssertEqual(f, [.init(event: "voice-chunk", data: "{\"seg\":1}", id: nil)])
    }

    func testCRLFAndComments() {
        var p = SSELineParser()
        let f = p.push(": keep-alive\r\nevent: ping\r\ndata: 1\r\n\r\n")
        XCTAssertEqual(f, [.init(event: "ping", data: "1", id: nil)])
    }

    func testBlankDataIsNotDispatched() {
        var p = SSELineParser()
        // A lone blank line with no buffered data lines emits nothing.
        XCTAssertTrue(p.push("\n").isEmpty)
    }

    func testTwoFramesInOnePush() {
        var p = SSELineParser()
        let f = p.push("data: one\n\ndata: two\n\n")
        XCTAssertEqual(f, [
            .init(event: "message", data: "one", id: nil),
            .init(event: "message", data: "two", id: nil),
        ])
    }
}
