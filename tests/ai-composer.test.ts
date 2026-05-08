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

  it("captures a known house_style pick", () => {
    const raw = fence({
      house_style: "sequoia-memo",
      spine: "a16z-thesis",
      rationale: "investment memo",
      components: [
        { kind: "thesis", order: 1 },
        { kind: "why-now", order: 2 },
        { kind: "big-ideas", order: 3 },
        { kind: "the-bet", order: 4 },
        { kind: "risk-register", order: 5 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.houseStyle).toBe("sequoia-memo");
  });

  it("falls back to boardroom-default for an unknown house_style", () => {
    const raw = fence({
      house_style: "made-up-style",
      spine: "boardroom-dark",
      rationale: "garbage style",
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
    expect(parsed!.houseStyle).toBe("boardroom-default");
  });

  it("infers spine from the picked house style when the spine field is missing", () => {
    const raw = fence({
      house_style: "anthropic",
      rationale: "no spine in payload",
      components: [
        { kind: "working-hypothesis", order: 1 },
        { kind: "headline-findings", order: 2 },
        { kind: "divergence", order: 3 },
        { kind: "considerations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    const parsed = parseComposerOutput(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.spine).toBe("anthropic-essay");
    expect(parsed!.houseStyle).toBe("anthropic");
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

describe("coverage matrix · validatePicks asset-driven rules", () => {
  function fence(json: object): string {
    return ["```json", JSON.stringify(json), "```"].join("\n");
  }

  // Baseline pick that satisfies anchor + findings + action + ≥5
  // components, plus has both `divergence` and `pre-mortem` and
  // `open-questions` and `metric-strip` so it can ROUTE through any
  // coverage trigger; tests below tweak it to omit specific
  // components and check the matrix rejects them.
  const fullCoverageComponents = [
    { kind: "bottom-line", order: 1 },
    { kind: "frame-shift", order: 2 },
    { kind: "headline-findings", order: 3 },
    { kind: "divergence", order: 4 },
    { kind: "risk-register", order: 5 },
    { kind: "metric-strip", order: 6 },
    { kind: "recommendations", order: 7 },
    { kind: "open-questions", order: 8 },
  ];

  it("accepts the full-coverage pick when all triggers fire", () => {
    const raw = fence({ spine: "boardroom-dark", rationale: "ok", components: fullCoverageComponents });
    const parsed = parseComposerOutput(raw, {
      tensions: 2, risks: 3, openQuestions: 1, actions: 2, dataAvailable: 4,
    });
    expect(parsed).not.toBeNull();
  });

  it("rejects when tensions ≥ 1 but neither divergence nor positions is picked", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "missing divergence",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "risk-register", order: 4 },
        { kind: "recommendations", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw, { tensions: 2 })).toBeNull();
  });

  it("rejects when risks ≥ 1 but neither risk-register nor threats-to-validity is picked", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "missing risk-register",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "divergence", order: 4 },
        { kind: "recommendations", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw, { risks: 3 })).toBeNull();
  });

  it("rejects when openQuestions ≥ 1 but neither open-questions nor new-questions is picked", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "missing open-questions",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "divergence", order: 4 },
        { kind: "risk-register", order: 5 },
        { kind: "recommendations", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw, { openQuestions: 2 })).toBeNull();
  });

  it("rejects when actions ≥ 2 but action component is considerations (softens imperatives)", () => {
    const raw = fence({
      spine: "anthropic-essay",
      rationale: "considerations softens",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "considerations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    expect(parseComposerOutput(raw, { actions: 4 })).toBeNull();
  });

  it("accepts considerations when actions < 2 (room produced ≤1 imperative — hedge is fine)", () => {
    const raw = fence({
      spine: "anthropic-essay",
      rationale: "considerations ok",
      components: [
        { kind: "working-hypothesis", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "considerations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    expect(parseComposerOutput(raw, { actions: 1 })).not.toBeNull();
  });

  it("rejects when dataAvailable ≥ 3 but neither metric-strip nor visuals is picked", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "missing metric-strip",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "divergence", order: 4 },
        { kind: "recommendations", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw, { dataAvailable: 5 })).toBeNull();
  });

  it("accepts when no asset context is supplied (legacy callers / tests bypass the matrix)", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "no coverage hints",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "considerations", order: 4 },
        { kind: "open-questions", order: 5 },
      ],
    });
    expect(parseComposerOutput(raw)).not.toBeNull();
  });

  it("positions satisfies the tensions trigger as an alternative to divergence", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "positions covers tensions",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "positions", order: 4 },
        { kind: "recommendations", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw, { tensions: 1 })).not.toBeNull();
  });

  it("threats-to-validity satisfies the risks trigger", () => {
    const raw = fence({
      spine: "boardroom-dark",
      rationale: "threats covers risks",
      components: [
        { kind: "bottom-line", order: 1 },
        { kind: "frame-shift", order: 2 },
        { kind: "headline-findings", order: 3 },
        { kind: "threats-to-validity", order: 4 },
        { kind: "recommendations", order: 5 },
        { kind: "open-questions", order: 6 },
      ],
    });
    expect(parseComposerOutput(raw, { risks: 2 })).not.toBeNull();
  });
});
