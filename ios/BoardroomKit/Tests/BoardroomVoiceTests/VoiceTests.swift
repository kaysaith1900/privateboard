import XCTest
@testable import BoardroomVoice

final class SpeechTests: XCTestCase {
    func testStripSpokenLabels() {
        XCTAssertEqual(Speech.stripSpokenLabels("【立场】We should ship."), "We should ship.")
        XCTAssertEqual(Speech.stripSpokenLabels("Plain text."), "Plain text.")
    }

    func testCleanForSpeech() {
        XCTAssertEqual(Speech.cleanForSpeech("**bold** and *em* text"), "bold and em text")
        XCTAssertEqual(Speech.cleanForSpeech("# Heading\n\ncontent"), "Heading\n\ncontent")
        XCTAssertEqual(Speech.cleanForSpeech("see [the docs](https://x.com)"), "see the docs")
        XCTAssertEqual(Speech.cleanForSpeech("- one\n- two"), "one\ntwo")
        XCTAssertEqual(Speech.cleanForSpeech("`code` inline"), "code inline")
        XCTAssertEqual(Speech.cleanForSpeech("visit https://example.com now"), "visit link now")
        XCTAssertEqual(Speech.cleanForSpeech("```\ncode block\n```\nafter"), "after")
        XCTAssertEqual(Speech.cleanForSpeech("a &amp; b"), "a & b")
    }

    func testCleanForSpeechKeepsCJK() {
        XCTAssertEqual(Speech.cleanForSpeech("**重点**是这个"), "重点是这个")
    }
}

final class SentenceSplitterTests: XCTestCase {
    func testLatin() {
        XCTAssertEqual(SentenceSplitter.split("Hello there. How are you? Fine!"),
                       ["Hello there.", "How are you?", "Fine!"])
    }
    func testCJK() {
        XCTAssertEqual(SentenceSplitter.split("你好。今天怎么样？很好！"),
                       ["你好。", "今天怎么样？", "很好！"])
    }
    func testNewlinesSplit() {
        XCTAssertEqual(SentenceSplitter.split("line one\nline two"), ["line one", "line two"])
    }
    func testEmptyAndWhitespace() {
        XCTAssertEqual(SentenceSplitter.split("   "), [])
        XCTAssertEqual(SentenceSplitter.split(""), [])
    }
}

final class TTSWireTests: XCTestCase {
    private let mm = VoiceProfile(provider: .minimax, model: "", voiceId: "female-shaonv",
                                  speed: 1.2, pitch: 2, volume: 1, emotion: "calm")

    func testMiniMaxRequest() throws {
        let req = try TTSWire.minimaxRequest(text: "hi", profile: mm, apiKey: "mk", region: "cn")
        XCTAssertEqual(req.url?.absoluteString, "https://api.minimaxi.com/v1/t2a_v2")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer mk")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["model"] as? String, "speech-2.8-hd")   // default
        XCTAssertEqual(body["stream"] as? Bool, false)
        let vs = try XCTUnwrap(body["voice_setting"] as? [String: Any])
        XCTAssertEqual(vs["voice_id"] as? String, "female-shaonv")
        XCTAssertEqual(vs["emotion"] as? String, "calm")
    }

    func testMiniMaxRegionURLs() {
        XCTAssertEqual(TTSWire.minimaxBaseURL(region: "cn"), "https://api.minimaxi.com")
        XCTAssertEqual(TTSWire.minimaxBaseURL(region: "intl"), "https://api.minimax.io")
    }

    func testMiniMaxParseHexToBase64() throws {
        // "Mq" = 0x4d 0x71 → base64 "TXE=".
        let json = #"{"data":{"audio":"4d71"},"base_resp":{"status_code":0}}"#
        let chunk = try TTSWire.parseMiniMax(Data(json.utf8), profile: mm, text: "hi", region: "cn")
        XCTAssertEqual(chunk.audioBase64, "TXE=")
        XCTAssertEqual(chunk.provider, "minimax")
        XCTAssertEqual(chunk.mimeType, "audio/mpeg")
    }

    func testMiniMaxBillingFromStatusCode() {
        let json = #"{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}"#
        XCTAssertThrowsError(try TTSWire.parseMiniMax(Data(json.utf8), profile: mm, text: "x", region: "cn")) {
            XCTAssertTrue($0 is TtsBillingError)
        }
    }

    func testOpenAIRequestClampsSpeed() throws {
        let p = VoiceProfile(provider: .openai, model: "", voiceId: "", speed: 9)
        let req = try TTSWire.openAIRequest(text: "hi", profile: p, apiKey: "k")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["speed"] as? Double, 4)        // clamped to 4
        XCTAssertEqual(body["voice"] as? String, "marin")  // default
        XCTAssertEqual(body["model"] as? String, "gpt-4o-mini-tts")
    }

    func testElevenLabsRequest() throws {
        let p = VoiceProfile(provider: .elevenlabs, model: "", voiceId: "Rachel")
        let req = try TTSWire.elevenLabsRequest(text: "hi", profile: p, apiKey: "xk")
        XCTAssertTrue(req.url?.absoluteString.contains("/text-to-speech/Rachel?output_format=mp3_44100_128") ?? false)
        XCTAssertEqual(req.value(forHTTPHeaderField: "xi-api-key"), "xk")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["model_id"] as? String, "eleven_multilingual_v2")
    }

    func testElevenLabsCreditErrorDetection() {
        XCTAssertTrue(TTSWire.isElevenLabsCreditError("quota_exceeded for this voice"))
        XCTAssertFalse(TTSWire.isElevenLabsCreditError("invalid voice id"))
    }
}
