import { describe, expect, it } from "vitest";

import {
  ANCHORS,
  ACTIONS,
  COMPONENT_KINDS,
  DEFAULT_PRESET,
  FINDINGS,
  defaultComposition,
  parseComposerOutput,
} from "../src/ai/prompts/composer.js";

describe("parseComposerOutput", () => {
  function fence(json: object): string {
    return ["Here is my pick.", "```json", JSON.stringify(json), "```"].join("\n");
  }

  it("accepts a well-formed composition and renumbers order contiguously", () => {
    const raw = fence({
      spine: "a16z-thesis",
      subject_type: "investment-judgement",
      rationale: "investment framing · pick a16z",
      components: [
        { kind: "thesis", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "big-ideas", order: 3 },
        { kind: "convergence", order: 4 },
        { kind: "the-bet", order: 5 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("a16z-thesis");
    expect(parsed!.subjectType).toBe("investment-judgement");
    expect(parsed!.fromComposer).toBe(true);
    expect(parsed!.components).toHaveLength(5);
    expect(parsed!.components.map((c) => c.kind)).toEqual([
      "thesis",
      "frame-shift",
      "big-ideas",
      "convergence",
      "the-bet",
    ]);
    expect(parsed!.components.map((c) => c.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects compositions missing an anchor", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "no anchor",
      components: [
        { kind: "frame-shift", order: 1 },
        { kind: "headline-findings", order: 2 },
        { kind: "convergence", order: 3 },
        { kind: "recommendations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    expect(parseComposerOutput(raw)).toBeNull();
  });

  it("rejects compositions with two anchors (substitute-group violation)", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "two anchors picked — invalid",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "thesis", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "recommendations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    expect(parseComposerOutput(raw)).toBeNull();
  });

  it("rejects compositions below the 5-component floor", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "too thin",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "headline-findings", order: 2 },
        { kind: "recommendations", order: 3 },
      ],
    });
    expect(parseComposerOutput(raw)).toBeNull();
  });

  it("rejects compositions above the 9-component cap", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "too noisy",
      components: COMPONENT_KINDS.slice(0, 11).map((k, i) => ({ kind: k, order: i + 1 })),
    });
    expect(parseComposerOutput(raw)).toBeNull();
  });

  it("drops unknown kinds silently rather than rejecting the whole pick", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "one unknown stripped",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "recommendations", order: 4 },
        { kind: "open-questions", order: 5 },
        { kind: "MADE-UP-KIND", order: 6 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.components.map((c) => c.kind)).not.toContain("MADE-UP-KIND");
    expect(parsed!.components).toHaveLength(5);
  });

  it("coerces an unknown spine value to boardroom-dark", () => {
    const raw = fence({
      spine: "not-a-real-spine",
      rationale: "garbage spine",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "recommendations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("boardroom-dark");
  });

  it("returns null when there is no JSON in the input", () => {
    expect(parseComposerOutput("just prose, no json here")).toBeNull();
  });

  it("dedupes a kind appearing twice", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "duplicate kind",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "convergence", order: 4 },
        { kind: "convergence", order: 5 },
        { kind: "recommendations", order: 6 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    const kinds = parsed!.components.map((c) => c.kind);
    expect(kinds.filter((k) => k === "convergence")).toHaveLength(1);
  });
});

describe("defaultComposition", () => {
  it("matches the legacy 12-section preset", () => {
    const fallback = defaultComposition("test reason");
    expect(fallback.fromComposer).toBe(false);
    expect(fallback.spine).toBe("boardroom-dark");
    expect(fallback.components).toHaveLength(DEFAULT_PRESET.length);
    expect(fallback.components.map((c) => c.kind)).toEqual(
      DEFAULT_PRESET.map((c) => c.kind),
    );
  });
});

describe("substitute groups", () => {
  it("anchors are bottom-line, thesis, working-hypothesis", () => {
    expect([...ANCHORS]).toEqual(["bottom-line", "thesis", "working-hypothesis"]);
  });
  it("findings are headline-findings, big-ideas", () => {
    expect([...FINDINGS]).toEqual(["headline-findings", "big-ideas"]);
  });
  it("actions are recommendations, the-bet, considerations", () => {
    expect([...ACTIONS]).toEqual(["recommendations", "the-bet", "considerations"]);
  });
});

describe("v2 component picks", () => {
  function fence(json: object): string {
    return ["```json", JSON.stringify(json), "```"].join("\n");
  }

  it("accepts an anthropic-essay composition (working-hypothesis + considerations)", () => {
    const raw = fence({
      spine: "anthropic-essay",
      subject_type: "philosophical",
      rationale: "open-ended exploration",
      components: [
        { kind: "working-hypothesis", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "considerations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("anthropic-essay");
    expect(parsed!.components.map((c) => c.kind)).toContain("working-hypothesis");
    expect(parsed!.components.map((c) => c.kind)).toContain("considerations");
  });

  it("accepts a full a16z-thesis composition (thesis + the-bet + why-now + two-paths)", () => {
    const raw = fence({
      spine: "a16z-thesis",
      subject_type: "investment-judgement",
      rationale: "should we back this bet",
      components: [
        { kind: "thesis", order: 1 },
        { kind: "big-ideas", order: 2 },
        { kind: "why-now", order: 3 },
        { kind: "two-paths", order: 4 },
        { kind: "the-bet", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("a16z-thesis");
    const kinds = parsed!.components.map((c) => c.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["thesis", "the-bet", "why-now", "two-paths"]),
    );
  });

  it("rejects compositions with two ACTIONS picked (substitute violation)", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "two actions invalid",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "recommendations", order: 4 },
        { kind: "considerations", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw)).toBeNull();
  });

  it("each spine in SPINES set resolves to a renderable spine", () => {
    for (const spine of [
      "boardroom-dark",
      "a16z-thesis",
      "anthropic-essay",
      "gartner-note",
      "mckinsey-deck",
      "openai-paper",
    ]) {
      const raw = fence({
        spine,
        rationale: "spine round-trip test",
        components: [
          { kind: "bottom-line", order: 1 },
          { kind: "frame-shift", order: 2 },
          { kind: "headline-findings", order: 3 },
          { kind: "recommendations", order: 4 },
          { kind: "open-questions", order: 5 },
        ],
      });
      const parsed = parseComposerOutput(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.spine).toBe(spine);
    }
  });
});
