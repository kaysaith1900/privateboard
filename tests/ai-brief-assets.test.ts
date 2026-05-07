import { describe, expect, it } from "vitest";

import {
  ASSET_CAPS,
  assetsToSignals,
  countAssets,
  parseDirectorAssets,
  type DirectorAssets,
} from "../src/ai/prompts/brief-stages.js";
import type { Agent } from "../src/storage/agents.js";

const director: Agent = {
  id: "socrates",
  name: "Socrates",
  handle: "/socrates",
  roleTag: "skeptic",
  bio: "doubt",
  coverQuote: null,
  instruction: "",
  modelV: "sonnet-4-6",
  avatarPath: "/a.svg",
  isPinned: false,
  isSeed: true,
  createdAt: 0,
  updatedAt: 0,
};

function fence(json: object): string {
  return ["Here's the asset bundle.", "```json", JSON.stringify(json), "```"].join("\n");
}

describe("parseDirectorAssets", () => {
  it("parses a fully-populated bundle across all 9 fields", () => {
    const raw = fence({
      claims: [
        { text: "Defensibility lives in the data flywheel.", lens: "structural", sources: [0, 2], confidence: "high" },
      ],
      evidence: [
        { text: "GMV down 23% Q3 on a 7% category baseline.", kind: "data", sources: [3] },
      ],
      tensions: [
        { text: "Long Horizon framed this as a moat play; I read it as distribution leverage.", with: ["long-horizon"], sources: [4] },
      ],
      assumptions: [
        { text: "Regulator timing slips by ≥2 quarters.", falsifier: "FTC files before March", sources: [5] },
      ],
      risks: [
        { text: "Channel concentration on 2 platforms creates fragility.", severity: "high", sources: [6] },
      ],
      opportunities: [
        { text: "Underserved mid-market segment.", sources: [7] },
      ],
      actions: [
        { text: "Run a 30-day pilot on the API-only tier.", owner: "product", horizon: "30 days", sources: [8] },
      ],
      quotes: [
        { text: "The defensibility lives in the data flywheel, not the UI.", sources: [2] },
      ],
      openQuestions: [
        { text: "What turns model-quality lead into a moat at our scale?", priority: "P0", sources: [3, 5] },
      ],
    });
    const a = parseDirectorAssets(raw, director);
    expect(a.directorId).toBe("socrates");
    expect(a.directorName).toBe("Socrates");
    expect(a.claims).toHaveLength(1);
    expect(a.claims[0].confidence).toBe("high");
    expect(a.evidence).toHaveLength(1);
    expect(a.evidence[0].kind).toBe("data");
    expect(a.tensions[0].with).toEqual(["long-horizon"]);
    expect(a.assumptions[0].falsifier).toBe("FTC files before March");
    expect(a.risks[0].severity).toBe("high");
    expect(a.opportunities).toHaveLength(1);
    expect(a.actions[0].owner).toBe("product");
    expect(a.actions[0].horizon).toBe("30 days");
    expect(a.quotes).toHaveLength(1);
    expect(a.openQuestions[0].priority).toBe("P0");
  });

  it("returns an empty bundle for empty / malformed input", () => {
    const a = parseDirectorAssets("not json", director);
    expect(a.directorId).toBe("socrates");
    expect(countAssets(a)).toBe(0);
  });

  it("accepts a bundle where all fields are empty arrays", () => {
    const raw = fence({
      claims: [], evidence: [], tensions: [], assumptions: [],
      risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
    });
    const a = parseDirectorAssets(raw, director);
    expect(countAssets(a)).toBe(0);
  });

  it("drops claim entries with bad lens / no sources / empty text", () => {
    const raw = fence({
      claims: [
        { text: "good", lens: "structural", sources: [0] },           // ok
        { text: "no sources", lens: "structural", sources: [] },      // dropped
        { text: "bad lens", lens: "wibble", sources: [1] },           // dropped
        { text: "", lens: "structural", sources: [2] },               // dropped
      ],
      evidence: [], tensions: [], assumptions: [],
      risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
    });
    const a = parseDirectorAssets(raw, director);
    expect(a.claims).toHaveLength(1);
    expect(a.claims[0].text).toBe("good");
  });

  it("caps each field at ASSET_CAPS regardless of overflow", () => {
    const raw = fence({
      claims: Array.from({ length: 20 }, (_, i) => ({
        text: `claim-${i}`, lens: "structural", sources: [i],
      })),
      evidence: [], tensions: [], assumptions: [],
      risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
    });
    const a = parseDirectorAssets(raw, director);
    expect(a.claims).toHaveLength(ASSET_CAPS.claims);
  });

  it("normalises evidence kind to 'case' when unknown", () => {
    const raw = fence({
      claims: [],
      evidence: [
        { text: "wibble", kind: "garbage", sources: [0] },
      ],
      tensions: [], assumptions: [],
      risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
    });
    const a = parseDirectorAssets(raw, director);
    expect(a.evidence[0].kind).toBe("case");
  });

  it("defaults openQuestion priority to P1 when missing or invalid", () => {
    const raw = fence({
      claims: [], evidence: [], tensions: [], assumptions: [],
      risks: [], opportunities: [], actions: [], quotes: [],
      openQuestions: [
        { text: "Q1", priority: "P0", sources: [0] },
        { text: "Q2", priority: "garbage", sources: [1] },
        { text: "Q3", sources: [2] },
      ],
    });
    const a = parseDirectorAssets(raw, director);
    expect(a.openQuestions.map((q) => q.priority)).toEqual(["P0", "P1", "P1"]);
  });
});

describe("assetsToSignals · transitional adapter", () => {
  function buildAssets(): DirectorAssets {
    return {
      directorId: "d1",
      directorName: "D",
      claims: [{ text: "C", lens: "structural", sources: [0] }],
      evidence: [{ text: "E", kind: "data", sources: [1] }],
      tensions: [{ text: "T", with: ["d2"], sources: [2] }],
      assumptions: [{ text: "A", sources: [3] }],
      risks: [{ text: "R", severity: "high", sources: [4] }],
      opportunities: [{ text: "O", sources: [5] }],
      actions: [{ text: "Act", owner: "product", horizon: "30d", sources: [6] }],
      quotes: [{ text: "Q", sources: [7] }],
      openQuestions: [{ text: "Q?", priority: "P0", sources: [8] }],
    };
  }

  it("flattens to one signal per asset entry, in field order", () => {
    const a = buildAssets();
    const s = assetsToSignals(a);
    expect(s.directorId).toBe("d1");
    expect(s.signals).toHaveLength(9);
    // First is the claim (claims field is first in iteration order).
    expect(s.signals[0].text.startsWith("[claim]")).toBe(true);
    // Risk text encodes severity.
    expect(s.signals[4].text).toContain("[risk·high]");
    // Action text encodes owner + horizon.
    expect(s.signals[6].text).toContain("[action·product·30d]");
    // Open question encodes priority.
    expect(s.signals[8].text).toContain("[open-q·P0]");
  });

  it("derives a lens for non-claim asset kinds", () => {
    const a = buildAssets();
    const s = assetsToSignals(a);
    // claim keeps its native lens
    expect(s.signals[0].lens).toBe("structural");
    // evidence (data) → data lens
    expect(s.signals[1].lens).toBe("data");
    // tension → dissent lens
    expect(s.signals[2].lens).toBe("dissent");
    // open question → first-principle lens
    expect(s.signals[8].lens).toBe("first-principle");
  });

  it("preserves source indices unchanged through the adapter", () => {
    const a = buildAssets();
    const s = assetsToSignals(a);
    expect(s.signals[0].sources).toEqual([0]);
    expect(s.signals[8].sources).toEqual([8]);
  });

  it("returns an empty signals[] for an empty asset bundle", () => {
    const empty: DirectorAssets = {
      directorId: "d1", directorName: "D",
      claims: [], evidence: [], tensions: [], assumptions: [],
      risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
    };
    const s = assetsToSignals(empty);
    expect(s.signals).toHaveLength(0);
  });
});

describe("countAssets", () => {
  it("sums every asset field", () => {
    const a: DirectorAssets = {
      directorId: "d1", directorName: "D",
      claims: [{ text: "x", lens: "data", sources: [0] }, { text: "y", lens: "data", sources: [0] }],
      evidence: [{ text: "z", kind: "data", sources: [0] }],
      tensions: [],
      assumptions: [],
      risks: [{ text: "r", sources: [0] }],
      opportunities: [],
      actions: [],
      quotes: [],
      openQuestions: [{ text: "q", priority: "P1", sources: [0] }],
    };
    expect(countAssets(a)).toBe(5);
  });
});
