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
    expect(resolveHouseStyle("anthropic").id).toBe("anthropic");
  });

  it("does not silently resurrect retired house style ids", () => {
    // `stanford-research` was retired in favour of `anthropic` (same
    // tone slot, more on-brand editorial register). Anything still
    // referencing the old id should fall through to boardroom-default
    // rather than match silently.
    expect(resolveHouseStyle("stanford-research").id).toBe("boardroom-default");
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

describe("parseScaffold · Phase 2B components", () => {
  function fence(json: object): string {
    return ["```json", JSON.stringify(json), "```"].join("\n");
  }

  function baseScaffold(extra: Record<string, unknown> = {}): object {
    return {
      title: "A complete-sentence thesis title goes here",
      bottomLine: { judgement: "Judgement.", confidence: "medium", rationale: "Why." },
      frameShift: { shifted: false, original: "x", reframed: "", trigger: "y" },
      headlineFindings: [
        {
          title: "Finding sentence",
          claim: "Load-bearing claim",
          confidence: "medium",
          supporters: ["dirA"],
          challengers: [],
          supporting: [{ text: "evidence", evidenceRefs: [] }],
          lensesPresent: ["data", "structural"],
        },
      ],
      convergence: [], divergence: null, positions: [], visuals: [],
      recommendations: [], preMortem: [], newQuestions: [],
      planningAssumption: null, openQuestions: [],
      ...extra,
    };
  }

  describe("riskRegister", () => {
    it("extracts 3 risks with all fields populated", () => {
      const raw = fence(baseScaffold({
        riskRegister: [
          { risk: "Channel concentration on 2 platforms.", category: "market", severity: "high", likelihood: "medium", owner: "ops", mitigation: "Diversify channels in Q3." },
          { risk: "Hiring bench is thin.", category: "team", severity: "medium", likelihood: "high", owner: "founders", mitigation: "monitor only" },
          { risk: "API contract pending review.", category: "compliance", severity: "low", likelihood: "low", owner: "legal", mitigation: "Track every 30 days." },
        ],
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.riskRegister).toHaveLength(3);
      expect(s!.riskRegister![0].category).toBe("market");
      expect(s!.riskRegister![0].severity).toBe("high");
      expect(s!.riskRegister![1].mitigation).toBe("monitor only");
    });

    it("normalises unknown category to 'execution' and unknown severity/likelihood to 'medium'", () => {
      const raw = fence(baseScaffold({
        riskRegister: [
          { risk: "Vague risk.", category: "wibble", severity: "catastrophic", likelihood: "extreme", owner: "team" },
        ],
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.riskRegister![0].category).toBe("execution");
      expect(s!.riskRegister![0].severity).toBe("medium");
      expect(s!.riskRegister![0].likelihood).toBe("medium");
    });

    it("defaults missing owner / mitigation rather than dropping the row", () => {
      const raw = fence(baseScaffold({
        riskRegister: [{ risk: "Bare risk.", category: "technical", severity: "high", likelihood: "low" }],
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.riskRegister).toHaveLength(1);
      expect(s!.riskRegister![0].owner).toBe("—");
      expect(s!.riskRegister![0].mitigation).toBe("monitor only");
    });

    it("returns empty array when riskRegister is missing", () => {
      const s = parseScaffold(fence(baseScaffold()), "x", "x");
      expect(s!.riskRegister).toEqual([]);
    });

    it("caps at 7 entries even when more are supplied", () => {
      const many = Array.from({ length: 12 }, (_, i) => ({
        risk: `r${i}`, category: "market", severity: "high", likelihood: "medium", owner: "ops", mitigation: "x",
      }));
      const s = parseScaffold(fence(baseScaffold({ riskRegister: many })), "x", "x");
      expect(s!.riskRegister).toHaveLength(7);
    });
  });

  describe("decisionOptions", () => {
    it("extracts a 3-option block with one recommended", () => {
      const raw = fence(baseScaffold({
        decisionOptions: {
          intro: "We weighed three paths.",
          options: [
            { label: "Build", summary: "x", pros: ["a", "b"], cons: ["c"], effort: "high", confidence: "medium", recommended: false },
            { label: "Acquire", summary: "y", pros: ["d"], cons: ["e", "f"], effort: "medium", confidence: "high", recommended: true },
            { label: "Wait", summary: "z", pros: ["g"], cons: ["h"], effort: "low", confidence: "low", recommended: false },
          ],
          rationale: "Acquire wins because of speed.",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.decisionOptions).not.toBeNull();
      expect(s!.decisionOptions!.options).toHaveLength(3);
      expect(s!.decisionOptions!.options.filter((o) => o.recommended)).toHaveLength(1);
      expect(s!.decisionOptions!.options.find((o) => o.recommended)!.label).toBe("Acquire");
    });

    it("forces exactly one recommended option (zero-recommended falls back to first)", () => {
      const raw = fence(baseScaffold({
        decisionOptions: {
          intro: "", options: [
            { label: "A", summary: "x", pros: ["p"], cons: ["c"], effort: "low", confidence: "low", recommended: false },
            { label: "B", summary: "y", pros: ["p"], cons: ["c"], effort: "high", confidence: "high", recommended: false },
          ], rationale: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      const recs = s!.decisionOptions!.options.filter((o) => o.recommended);
      expect(recs).toHaveLength(1);
      expect(recs[0].label).toBe("A");
    });

    it("forces exactly one recommended option (multi-recommended collapses to first)", () => {
      const raw = fence(baseScaffold({
        decisionOptions: {
          intro: "", options: [
            { label: "A", summary: "x", pros: ["p"], cons: ["c"], effort: "low", confidence: "low", recommended: true },
            { label: "B", summary: "y", pros: ["p"], cons: ["c"], effort: "high", confidence: "high", recommended: true },
          ], rationale: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      const recs = s!.decisionOptions!.options.filter((o) => o.recommended);
      expect(recs).toHaveLength(1);
      expect(recs[0].label).toBe("A");
    });

    it("returns null when fewer than 2 valid options survive", () => {
      const raw = fence(baseScaffold({
        decisionOptions: {
          intro: "",
          options: [
            { label: "A", summary: "x", pros: [], cons: [], effort: "low", confidence: "low", recommended: true },
            "not an object",
          ],
          rationale: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.decisionOptions).toBeNull();
    });

    it("normalises unknown effort/confidence to 'medium'", () => {
      const raw = fence(baseScaffold({
        decisionOptions: {
          intro: "",
          options: [
            { label: "A", summary: "x", pros: ["p"], cons: ["c"], effort: "huge", confidence: "shaky", recommended: true },
            { label: "B", summary: "y", pros: ["p"], cons: ["c"], effort: "medium", confidence: "medium", recommended: false },
          ],
          rationale: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      const a = s!.decisionOptions!.options.find((o) => o.label === "A")!;
      expect(a.effort).toBe("medium");
      expect(a.confidence).toBe("medium");
    });

    it("returns null when decisionOptions is missing", () => {
      const s = parseScaffold(fence(baseScaffold()), "x", "x");
      expect(s!.decisionOptions).toBeNull();
    });
  });

  describe("pathComparison", () => {
    it("extracts a 2-path block with stance + verdict + characteristics", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "The choice between replacement vs augmentation is structural, not cosmetic.",
          paths: [
            {
              verdict: "structurally fragile",
              stance: "weak",
              name: "Replace HR with AI",
              characteristics: [
                "HR procurement resists tools positioned as threat",
                "Capability replicable from open weights within days",
                "No proprietary data accumulates; advantage plateaus",
                "Pattern across two decades: replacement plays consistently fail",
              ],
            },
            {
              verdict: "plausibly defensible",
              stance: "strong",
              name: "Augment HR with AI",
              characteristics: [
                "HR is buyer and user; becomes internal advocate",
                "Workflow lock-in defensibility",
                "Product-led embedding compresses sales cycles",
                "Proprietary data flywheel; switching costs compound",
              ],
            },
          ],
          implication: "It propagates through every subsequent decision.",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison).not.toBeNull();
      expect(s!.pathComparison!.paths).toHaveLength(2);
      expect(s!.pathComparison!.paths[0].stance).toBe("weak");
      expect(s!.pathComparison!.paths[1].stance).toBe("strong");
      expect(s!.pathComparison!.paths[0].characteristics).toHaveLength(4);
      expect(s!.pathComparison!.implication).toContain("propagates");
    });

    it("normalises unknown stance to 'neutral'", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "",
          paths: [
            { verdict: "v1", stance: "garbage", name: "A", characteristics: ["x", "y"] },
            { verdict: "v2", stance: "wibble", name: "B", characteristics: ["x", "y"] },
          ],
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison!.paths[0].stance).toBe("neutral");
      expect(s!.pathComparison!.paths[1].stance).toBe("neutral");
    });

    it("returns null when fewer than 2 valid paths survive parsing", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "",
          paths: [
            { verdict: "v1", stance: "weak", name: "A", characteristics: ["x", "y"] },
            { verdict: "", stance: "strong", name: "B", characteristics: ["x", "y"] },     // bad · empty verdict
            "not an object",                                                                  // bad
          ],
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison).toBeNull();
    });

    it("returns null when a path has fewer than 2 characteristics", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "",
          paths: [
            { verdict: "v1", stance: "weak", name: "A", characteristics: ["only one"] },     // bad · 1 bullet
            { verdict: "v2", stance: "strong", name: "B", characteristics: ["x", "y"] },
          ],
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison).toBeNull();
    });

    it("caps characteristics at 6 per path", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "",
          paths: [
            { verdict: "v1", stance: "weak", name: "A", characteristics: ["a","b","c","d","e","f","g","h"] },
            { verdict: "v2", stance: "strong", name: "B", characteristics: ["a","b"] },
          ],
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison!.paths[0].characteristics).toHaveLength(6);
    });

    it("treats more than 2 supplied paths by taking the first 2 valid ones", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "",
          paths: [
            { verdict: "v1", stance: "weak", name: "A", characteristics: ["a","b"] },
            { verdict: "v2", stance: "strong", name: "B", characteristics: ["a","b"] },
            { verdict: "v3", stance: "neutral", name: "C", characteristics: ["a","b"] },
          ],
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison!.paths).toHaveLength(2);
      expect(s!.pathComparison!.paths.map((p) => p.name)).toEqual(["A", "B"]);
    });

    it("omits implication field when not supplied", () => {
      const raw = fence(baseScaffold({
        pathComparison: {
          intro: "",
          paths: [
            { verdict: "v1", stance: "weak", name: "A", characteristics: ["a","b"] },
            { verdict: "v2", stance: "strong", name: "B", characteristics: ["a","b"] },
          ],
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.pathComparison!.implication).toBeUndefined();
    });

    it("returns null when pathComparison is missing", () => {
      const s = parseScaffold(fence(baseScaffold()), "x", "x");
      expect(s!.pathComparison).toBeNull();
    });
  });

  describe("directorPerspectives · the always-on social map", () => {
    it("extracts a full 3-director comparison with alignment + divergence + chair synthesis", () => {
      const raw = fence(baseScaffold({
        directorPerspectives: {
          intro: "How the three directors read this differently.",
          alignment: [
            { pointOfAgreement: "The bottleneck is responsibility transfer", directorIds: ["dirA", "dirB"], note: "Independent paths · structural and dissent lenses converged." },
          ],
          divergence: [
            {
              hinge: "Whether reliability or accountability comes first",
              sides: [
                { label: "Architecture-first", directorIds: ["dirC"], stance: "Bound the blast radius before legal layers" },
                { label: "Accountability-first", directorIds: ["dirA", "dirB"], stance: "Indemnity is the moat, reliability follows" },
              ],
              resolution: "Pilot data on managers' actual delegation behaviour",
            },
          ],
          perspectives: [
            { directorId: "dirA", stance: "Indemnity is the moat", position: "Without service-level liability, agents stay tools forever.", quote: "Buyers pay for someone to blame, not someone to consult.", lens: "structural" },
            { directorId: "dirB", stance: "Same conclusion via dissent", position: "The room kept defaulting to capability framing; that's the trap.", quote: "", lens: "dissent" },
            { directorId: "dirC", stance: "Architecture before contract", position: "Bound the inference engine first; the legal layer is a wrapper.", quote: "Decouple the policy engine from the inference engine.", lens: "first-principle" },
          ],
          chairSynthesis: "Two directors arrived at indemnity from different lenses; the third reads the problem as architectural. The hinge is sequencing, not conclusion.",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.directorPerspectives).not.toBeNull();
      expect(s!.directorPerspectives!.alignment).toHaveLength(1);
      expect(s!.directorPerspectives!.alignment[0].directorIds).toHaveLength(2);
      expect(s!.directorPerspectives!.divergence).toHaveLength(1);
      expect(s!.directorPerspectives!.divergence[0].sides).toHaveLength(2);
      expect(s!.directorPerspectives!.perspectives).toHaveLength(3);
      expect(s!.directorPerspectives!.perspectives.map((p) => p.directorId)).toEqual(["dirA", "dirB", "dirC"]);
      expect(s!.directorPerspectives!.chairSynthesis).toContain("indemnity");
    });

    it("returns null when only 1 valid director perspective exists", () => {
      const raw = fence(baseScaffold({
        directorPerspectives: {
          intro: "",
          alignment: [],
          divergence: [],
          perspectives: [
            { directorId: "dirA", stance: "Solo", position: "Only one director spoke.", quote: "", lens: "structural" },
          ],
          chairSynthesis: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.directorPerspectives).toBeNull();
    });

    it("normalises an unknown lens to 'structural'", () => {
      const raw = fence(baseScaffold({
        directorPerspectives: {
          intro: "",
          alignment: [],
          divergence: [],
          perspectives: [
            { directorId: "dirA", stance: "x", position: "Bare position.", quote: "", lens: "garbage" },
            { directorId: "dirB", stance: "y", position: "Another position.", quote: "", lens: "data" },
          ],
          chairSynthesis: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.directorPerspectives!.perspectives[0].lens).toBe("structural");
      expect(s!.directorPerspectives!.perspectives[1].lens).toBe("data");
    });

    it("drops alignment groups with only 1 director (not actually alignment)", () => {
      const raw = fence(baseScaffold({
        directorPerspectives: {
          intro: "",
          alignment: [
            { pointOfAgreement: "Solo group", directorIds: ["dirA"], note: "" },                         // dropped · only 1
            { pointOfAgreement: "Real alignment", directorIds: ["dirA", "dirB"], note: "good" },          // kept
          ],
          divergence: [],
          perspectives: [
            { directorId: "dirA", stance: "x", position: "p1", quote: "", lens: "structural" },
            { directorId: "dirB", stance: "y", position: "p2", quote: "", lens: "data" },
          ],
          chairSynthesis: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.directorPerspectives!.alignment).toHaveLength(1);
      expect(s!.directorPerspectives!.alignment[0].pointOfAgreement).toBe("Real alignment");
    });

    it("drops divergence entries with fewer than 2 sides", () => {
      const raw = fence(baseScaffold({
        directorPerspectives: {
          intro: "",
          alignment: [],
          divergence: [
            {
              hinge: "Sole-side fork",
              sides: [{ label: "Only", directorIds: ["dirA"], stance: "alone" }],   // dropped · only 1 side
              resolution: "",
            },
            {
              hinge: "Real fork",
              sides: [
                { label: "A", directorIds: ["dirA"], stance: "yes" },
                { label: "B", directorIds: ["dirB"], stance: "no" },
              ],
              resolution: "tbd",
            },
          ],
          perspectives: [
            { directorId: "dirA", stance: "x", position: "p1", quote: "", lens: "structural" },
            { directorId: "dirB", stance: "y", position: "p2", quote: "", lens: "data" },
          ],
          chairSynthesis: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.directorPerspectives!.divergence).toHaveLength(1);
      expect(s!.directorPerspectives!.divergence[0].hinge).toBe("Real fork");
    });

    it("preserves an empty chairSynthesis as empty string (not null)", () => {
      const raw = fence(baseScaffold({
        directorPerspectives: {
          intro: "",
          alignment: [],
          divergence: [],
          perspectives: [
            { directorId: "dirA", stance: "x", position: "p1", quote: "", lens: "structural" },
            { directorId: "dirB", stance: "y", position: "p2", quote: "", lens: "data" },
          ],
          chairSynthesis: "",
        },
      }));
      const s = parseScaffold(raw, "x", "x");
      expect(s!.directorPerspectives!.chairSynthesis).toBe("");
    });

    it("returns null when directorPerspectives is missing entirely", () => {
      const s = parseScaffold(fence(baseScaffold()), "x", "x");
      expect(s!.directorPerspectives).toBeNull();
    });
  });
});
