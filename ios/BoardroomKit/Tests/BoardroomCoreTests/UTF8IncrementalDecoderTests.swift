import XCTest
@testable import BoardroomCore

final class UTF8IncrementalDecoderTests: XCTestCase {
    func testAsciiPassesThrough() {
        var d = UTF8IncrementalDecoder()
        XCTAssertEqual(d.push(Data("hello".utf8)), "hello")
    }

    func testMultibyteSplitAcrossChunks() {
        // "你" = E4 BD A0. Split it across three pushes; only the final byte completes it.
        var d = UTF8IncrementalDecoder()
        let bytes = Array("你".utf8)
        XCTAssertEqual(bytes.count, 3)
        XCTAssertEqual(d.push(Data([bytes[0]])), "")          // incomplete
        XCTAssertEqual(d.push(Data([bytes[1]])), "")          // still incomplete
        XCTAssertEqual(d.push(Data([bytes[2]])), "你")        // completes
    }

    func testMixedBoundary() {
        // "a你b" where the chunk ends mid-你.
        var d = UTF8IncrementalDecoder()
        let all = Array("a你b".utf8)   // 61 E4 BD A0 62
        let r1 = d.push(Data(all[0..<3]))   // "a" + first 2 bytes of 你 → only "a" emerges
        XCTAssertEqual(r1, "a")
        let r2 = d.push(Data(all[3...]))    // A0 62 → "你b"
        XCTAssertEqual(r2, "你b")
    }

    func testEmoji4Byte() {
        var d = UTF8IncrementalDecoder()
        let e = Array("🎙".utf8)   // 4 bytes
        XCTAssertEqual(e.count, 4)
        XCTAssertEqual(d.push(Data(e[0..<2])), "")
        XCTAssertEqual(d.push(Data(e[2...])), "🎙")
    }

    func testFlushReturnsCarry() {
        var d = UTF8IncrementalDecoder()
        _ = d.push(Data([0xE4]))   // incomplete lead
        // genuinely truncated → flush decodes to replacement, non-empty.
        XCTAssertFalse(d.flush().isEmpty)
    }
}
