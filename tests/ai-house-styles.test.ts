import { describe, expect, it } from "vitest";

import {
  HOUSE_STYLES,
  houseStyleLabel,
  resolveHouseStyle,
} from "../src/ai/prompts/house-styles.js";
import { parseScaffold } from "../src/ai/prompts/brief-stages.js";

describe("resolveHouseStyle", () => {
  it("returns the matching house style for a known id", () => {
    expect(resolveHouseStyle("sequoia-memo").id).toBe("sequoia-memo");
    expect(resolveHouseStyle("stanford-research").id).toBe("stanford-research");
  });

  it("falls back to boardroom-default for unknown / null / undefined ids", () => {
    expect(resolveHouseStyle("not-a-style").id).toBe("boardroom-default");
    expect(resolveHouseStyle(null).id).toBe("boardroom-default");
    expect(resolveHouseStyle(undefined).id).toBe("boardroom-default");
  });

  it("ships exactly the documented preset count", () => {
    expect(HOUSE_STYLES.length).toBeGreaterThanOrEqual(7);
    const ids = HOUSE_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("boardroom-default");
  });
});

describe("houseStyleLabel · variant rotation", () => {
  // sequoia-memo's `headline-findings` carries multiple variants per
  // catalog. The rotation must be:
  //   · stable across calls with the same seed
  //   · vary for different seeds (otherwise every brief reads identically)
  //   · the same seed must be allowed to land on different variants for
  //     different kinds (otherwise every override in a brief picks
  //     variant 0 of its array)
  const sequoia = resolveHouseStyle("sequoia-memo");

  it("returns the same label on repeated calls with the same seed", () => {
    const a = houseStyleLabel(sequoia, "headline-findings", "en", "brief-abc");
    const b = houseStyleLabel(sequoia, "headline-findings", "en", "brief-abc");
    expect(a).toBe(b);
  });

  it("eventually returns different labels for different seeds", () => {
    const seeds = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"];
    const labels = new Set(
      seeds.map((s) => houseStyleLabel(sequoia, "headline-findings", "en", s)),
    );
    // sequoia has 2 variants for headline-findings; with 10 seeds we
    // expect to see both surfaces (deterministic, but spread well).
    expect(labels.size).toBeGreaterThan(1);
  });

  it("returns the zh variant when language is zh", () => {
    const out = houseStyleLabel(sequoia, "headline-findings", "zh", "brief-z");
    expect(out).not.toBeNull();
    // The label should not be one of the en-only strings.
    expect(out).not.toBe("The Pillars");
    expect(out).not.toBe("Why We Like It");
  });

  it("returns null for kinds the house style doesn't override", () => {
    // boardroom-default has labels: {} — every kind returns null.
    const def = resolveHouseStyle("boardroom-default");
    expect(houseStyleLabel(def, "headline-findings", "en", "x")).toBeNull();
    expect(houseStyleLabel(def, "recommendations", "en", "x")).toBeNull();
  });
});

describe("parseScaffold · threats-to-validity + dense blocks", () => {
  function fence(json: object): string {
    return ["Here is the scaffold.", "```json", JSON.stringify(json), "```"].join("\n");
  }

  // Minimum valid scaffold body that parseScaffold accepts (anchor +
  // findings) — used as the spine for testing optional dense blocks.
  function baseScaffold(extra: Record<string, unknown> = {}): object {
    return {
      title: "A complete-sentence thesis title goes here",
      bottomLine: {
        judgement: "This is the load-bearing judgement.",
        confidence: "medium",
        rationale: "Why medium and not higher.",
      },
      frameShift: {
        shifted: false,
        original: "What the question looked like at the open.",
        reframed: "",
        trigger: "Frame held; the room sharpened it.",
      },
      headlineFindings: [
        {
          title: "First finding sentence",
          claim: "First load-bearing claim",
          confidence: "medium",
          supporters: ["dirA"],
          challengers: [],
          supporting: [{ text: "evidence sub-finding", evidenceRefs: [] }],
          lensesPresent: ["data", "structural"],
        },
      ],
      convergence: [],
      divergence: null,
      positions: [],
      visuals: [],
      recommendations: [],
      preMortem: [],
      newQuestions: [],
      planningAssumption: null,
      openQuestions: [],
      ...extra,
    };
  }

  it("extracts threatsToValidity into the parsed scaffold", () => {
    const raw = fence(
      baseScaffold({
        threatsToValidity: [
          {
            category: "Selection bias",
            threat: "We only consulted Western strategy directors so the read may not generalize.",
            observable: "Reports out of non-Western markets contradicting our base case.",
            severity: "high",
            mitigation: "Add a regional lens director before the next session.",
          },
          {
            category: "Sample of N=1",
            threat: "The judgement leans on a single precedent from 2019.",
            observable: "Subsequent cases diverging from the 2019 trajectory.",
            severity: "medium",
            mitigation: null,
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback title", "fallback q");
    expect(scaffold).not.toBeNull();
    expect(scaffold!.threatsToValidity).not.toBeNull();
    expect(scaffold!.threatsToValidity!).toHaveLength(2);
    expect(scaffold!.threatsToValidity![0].category).toBe("Selection bias");
    expect(scaffold!.threatsToValidity![0].severity).toBe("high");
    expect(scaffold!.threatsToValidity![1].mitigation).toBeNull();
  });

  it("drops malformed threat entries and keeps the well-formed ones", () => {
    const raw = fence(
      baseScaffold({
        threatsToValidity: [
          { category: "Confounding", threat: "", observable: "x", severity: "low", mitigation: null },     // missing threat
          { category: "Real one",     threat: "Concrete threat sentence.", observable: "Observable.", severity: "medium" },
          "not an object",
          null,
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback title", "fallback q");
    expect(scaffold!.threatsToValidity).toHaveLength(1);
    expect(scaffold!.threatsToValidity![0].category).toBe("Real one");
    expect(scaffold!.threatsToValidity![0].mitigation).toBeNull();
  });

  it("returns null for threatsToValidity when the field is absent", () => {
    const raw = fence(baseScaffold());
    const scaffold = parseScaffold(raw, "fallback title", "fallback q");
    expect(scaffold).not.toBeNull();
    expect(scaffold!.threatsToValidity).toBeNull();
  });

  it("extracts criticalAssumptions when supplied (previously dropped)", () => {
    const raw = fence(
      baseScaffold({
        criticalAssumptions: [
          {
            statement: "The brief assumes the regulatory regime stays open.",
            confidence: "medium",
            falsifier: "An EU-wide ban on the practice.",
            horizon: "next 18 months",
            attribution: "Long Horizon · structural",
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.criticalAssumptions).not.toBeNull();
    expect(scaffold!.criticalAssumptions!).toHaveLength(1);
    expect(scaffold!.criticalAssumptions![0].confidence).toBe("medium");
  });

  it("extracts metricStrip with intro + 3+ cards", () => {
    const raw = fence(
      baseScaffold({
        metricStrip: {
          intro: "Three numbers worth pricing in",
          cards: [
            { label: "API revenue at risk", value: "≤ 8%", qualifier: "of total ARR", attribution: "First Principles · data" },
            { label: "Window before parity", value: "18 mo", trend: "down", qualifier: "unless training data leaks" },
            { label: "Convergence rate", value: "2 of 3", qualifier: "directors at high confidence" },
          ],
        },
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.metricStrip).not.toBeNull();
    const strip = scaffold!.metricStrip!;
    expect(strip.intro).toBe("Three numbers worth pricing in");
    expect(strip.cards).toHaveLength(3);
    expect(strip.cards[1].trend).toBe("down");
    expect(strip.cards[2].attribution).toBeNull();
    expect(strip.cards[0].qualifier).toBe("of total ARR");
  });

  it("drops the metricStrip when fewer than 3 valid cards survive parsing", () => {
    const raw = fence(
      baseScaffold({
        metricStrip: {
          intro: "x",
          cards: [
            { label: "API revenue at risk", value: "≤ 8%" },
            { label: "", value: "18 mo" },        // bad · no label
            { label: "ok", value: "" },            // bad · no value
            "not an object",
          ],
        },
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.metricStrip).toBeNull();
  });

  it("normalises an unknown trend value to null", () => {
    const raw = fence(
      baseScaffold({
        metricStrip: {
          intro: "",
          cards: [
            { label: "A", value: "1", trend: "skyward" },   // invalid
            { label: "B", value: "2", trend: "up" },        // valid
            { label: "C", value: "3" },                      // missing
          ],
        },
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.metricStrip!.cards[0].trend).toBeNull();
    expect(scaffold!.metricStrip!.cards[1].trend).toBe("up");
    expect(scaffold!.metricStrip!.cards[2].trend).toBeNull();
  });

  it("extracts a bar-chart visual with 2+ bars", () => {
    const raw = fence(
      baseScaffold({
        visuals: [
          {
            type: "bar-chart",
            title: "Estimated time-to-ship",
            yLabel: "Months to ship",
            unit: "mo",
            bars: [
              { label: "Option A", value: 6 },
              { label: "Option B", value: 14 },
              { label: "Option C", value: 22 },
            ],
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.visuals).toHaveLength(1);
    const v = scaffold!.visuals[0] as { type: string; bars: { label: string; value: number }[]; yLabel: string };
    expect(v.type).toBe("bar-chart");
    expect(v.bars).toHaveLength(3);
    expect(v.bars[1].value).toBe(14);
    expect(v.yLabel).toBe("Months to ship");
  });

  it("drops a bar-chart with only 1 bar (not a comparison)", () => {
    const raw = fence(
      baseScaffold({
        visuals: [
          {
            type: "bar-chart",
            title: "Solo",
            yLabel: "Count",
            unit: "",
            bars: [{ label: "Only one", value: 5 }],
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.visuals).toHaveLength(0);
  });

  it("extracts a timeline visual with 3+ points", () => {
    const raw = fence(
      baseScaffold({
        visuals: [
          {
            type: "timeline",
            title: "How the platform reached parity",
            points: [
              { period: "2019", label: "First open weights ship", description: "..." },
              { period: "2022", label: "Tooling matures", description: "" },
              { period: "Today", label: "Parity within reach", description: "Frontier still ahead." },
            ],
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.visuals).toHaveLength(1);
    const v = scaffold!.visuals[0] as { type: string; points: unknown[] };
    expect(v.type).toBe("timeline");
    expect(v.points).toHaveLength(3);
  });

  it("drops a timeline with fewer than 3 points", () => {
    const raw = fence(
      baseScaffold({
        visuals: [
          {
            type: "timeline",
            title: "Stub",
            points: [
              { period: "2019", label: "Only event", description: "" },
              { period: "2024", label: "Second", description: "" },
            ],
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.visuals).toHaveLength(0);
  });

  it("extracts a pie-chart visual with 2+ slices and rejects negatives", () => {
    const raw = fence(
      baseScaffold({
        visuals: [
          {
            type: "pie-chart",
            title: "Scenario probability split",
            slices: [
              { label: "Base", value: 55 },
              { label: "Upside", value: 25 },
              { label: "Downside", value: 20 },
              { label: "Bug · negative", value: -10 },        // dropped
            ],
          },
        ],
      }),
    );
    const scaffold = parseScaffold(raw, "fallback", "fallback");
    expect(scaffold!.visuals).toHaveLength(1);
    const v = scaffold!.visuals[0] as { type: string; slices: { label: string; value: number }[] };
    expect(v.type).toBe("pie-chart");
    expect(v.slices).toHaveLength(3);
    expect(v.slices.every((s) => s.value >= 0)).toBe(true);
  });
});
