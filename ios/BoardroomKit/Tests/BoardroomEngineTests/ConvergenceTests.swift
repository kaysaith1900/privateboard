import XCTest
@testable import BoardroomEngine

final class ConvergenceTests: XCTestCase {
    func testTokenizeDropsStopwordsAndSingleChars() {
        // "the" (stopword), "a" (stopword+single), "x" (single) dropped; CJK split per char.
        XCTAssertEqual(Convergence.tokenize("The quick fox a x"), ["quick", "fox"])
        XCTAssertEqual(Convergence.tokenize("增长 strategy"), ["增", "长", "strategy"])
    }

    /// Known TF-IDF property (faithful to convergence.ts): a term in EVERY doc
    /// has idf = log((n+1)/(n+1)) = 0, so identical turns carry no discriminative
    /// weight and score 0. The heuristic's signal comes from mid-frequency terms.
    func testIdenticalTurnsScoreZeroByIdfCollapse() {
        let same = Array(repeating: "we must optimize the growth funnel conversion", count: 5)
        XCTAssertEqual(Convergence.tfidfScore(same), 0.0, accuracy: 0.0001)
    }

    func testDisjointVocabScoresZero() {
        let disjoint = ["alpha beta gamma", "delta epsilon zeta"]
        XCTAssertEqual(Convergence.tfidfScore(disjoint), 0.0, accuracy: 0.0001)
    }

    func testPartialOverlapScoresPositiveAndBounded() {
        // doc0 & doc1 share mid-df terms (in 2 of 3 docs → nonzero idf, overlap);
        // doc2 is disjoint. Mean pairwise cosine is in (0, 1).
        let s = Convergence.tfidfScore(["alpha beta gamma", "alpha beta delta", "epsilon zeta eta"])
        XCTAssertGreaterThan(s, 0)
        XCTAssertLessThan(s, 1)
    }

    func testOverlappingClusterScoresHigherThanDiverse() {
        // Mid-frequency overlap: each term appears in exactly 2 of 4 docs (idf>0)
        // and every pair shares at least one term → positive mean cosine.
        let clustered = [
            "retention churn alpha", "retention churn beta",
            "growth funnel alpha", "growth funnel beta",
        ]
        // Fully disjoint vocab → mean cosine 0.
        let diverse = [
            "quantum entanglement particle correlation",
            "medieval trade spice economies",
            "reinforcement reward policy signals",
            "coral reef symbiotic algae",
        ]
        XCTAssertGreaterThan(Convergence.tfidfScore(clustered), 0)
        XCTAssertEqual(Convergence.tfidfScore(diverse), 0.0, accuracy: 0.0001)
        XCTAssertGreaterThan(Convergence.tfidfScore(clustered), Convergence.tfidfScore(diverse))
    }

    func testDetectSkipsBelowMinTurns() async {
        let signal = await Convergence.detect(turns: ["a turn", "another"])  // <4
        XCTAssertEqual(signal.source, .skip)
        XCTAssertFalse(signal.converging)
    }

    func testDetectUsesLLMScoreWhenProvided() async {
        let turns = Array(repeating: "growth funnel optimization conversion metrics", count: 4)
        let signal = await Convergence.detect(turns: turns) { _ in (score: 0.91, note: "growth obsession") }
        XCTAssertEqual(signal.source, .llm)
        XCTAssertTrue(signal.converging)         // 0.91 ≥ 0.78
        XCTAssertEqual(signal.note, "growth obsession")
    }

    func testDetectFallsBackToTfidfWhenLLMReturnsNil() async {
        let turns = ["retention churn cohort alpha", "retention churn cohort beta",
                     "retention churn cohort gamma", "retention churn cohort delta"]
        let signal = await Convergence.detect(turns: turns) { _ in nil }
        XCTAssertEqual(signal.source, .tfidf)    // fell back; flag depends on the mid-df overlap
    }

    func testLLMScoreClampedBelowThresholdNotConverging() async {
        let turns = Array(repeating: "x y z content here", count: 4)
        let signal = await Convergence.detect(turns: turns) { _ in (score: 0.5, note: "diverse") }
        XCTAssertEqual(signal.score, 0.5, accuracy: 0.0001)
        XCTAssertFalse(signal.converging)        // 0.5 < 0.78
    }
}
