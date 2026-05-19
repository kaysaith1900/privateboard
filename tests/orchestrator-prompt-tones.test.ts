/**
 * Tone × intensity prompt-construction regression tests.
 *
 * The 5 tones × 3 intensities matrix (15 cells) is defined in
 * `src/orchestrator/prompt.ts`. Each cell ships its own marker phrases
 * in TONE_GUIDANCE / INTENSITY_GUIDANCE, plus tone-aware HOUSE_ENGAGE
 * and OVERRIDE lines. This file asserts that for each cell:
 *
 *   · the system prompt actually carries the tone block + headers
 *   · tone-signature phrases land (yes-and / steelman / BLOCKER / etc.)
 *   · intensity-signature phrases land (minimal / measured / decisive)
 *   · HOUSE RULES "engage" line uses the tone-correct verbs
 *   · the closing OVERRIDE meta-line targets the tone-correct training-bias
 *   · every tone now ships a PERSONA OVERRIDE paragraph (the bidirectional
 *     symmetry added alongside this test — soft tones override the
 *     persona's adversarial DNA, hard tones override its consensus DNA)
 *
 * If a future edit drifts one of these blocks (e.g. someone renames
 * BLOCKER · MAJOR · MINOR → CRITICAL · HIGH · LOW), this test fails
 * loudly — surfacing the drift instead of letting it ship.
 */
import { describe, expect, it } from "vitest";

import { buildDirectorMessages, parseRoundEndOutput } from "../src/orchestrator/prompt.js";
import type { Agent } from "../src/storage/agents.js";
import type { Prefs } from "../src/storage/prefs.js";
import type { Room } from "../src/storage/rooms.js";

function fixtureAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "Socrates",
    handle: "@socrates",
    roleTag: "First-Principles Skeptic",
    roleKind: "director",
    bio: "Tests every premise.",
    coverQuote: null,
    instruction: "You are Socrates. Lead with the disagreement.",
    modelV: "opus-4-7",
    carrierPref: null,
    avatarPath: "",
    ability: null,
    isPinned: false,
    isSeed: false,
    webSearchEnabled: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function fixtureRoom(mode: string, intensity: string): Room {
  return {
    id: "room-1",
    number: 1,
    name: "Test room",
    subject: "Should we rebuild the data layer?",
    mode,
    intensity,
    status: "live",
    briefStyle: null,
    awaitingContinue: false,
    awaitingClarify: false,
    createdAt: 0,
    pausedAt: null,
    adjournedAt: null,
    incognito: false,
    parentRoomId: null,
    parentBriefId: null,
    deliveryMode: "text",
  };
}

function fixturePrefs(): Prefs {
  return {
    name: "Kay",
    intro: "engineer",
    avatarSeed: null,
    defaultModelV: null,
    webSearchProvider: "brave",
    minimaxRegion: "cn",
    createdAt: 0,
    updatedAt: 0,
  };
}

function buildSystemPrompt(mode: string, intensity: string): string {
  const speaker = fixtureAgent({ id: "speaker", name: "Speaker", handle: "@speaker" });
  const peer = fixtureAgent({ id: "peer", name: "Peer", handle: "@peer" });
  const msgs = buildDirectorMessages({
    speaker,
    cast: [speaker, peer],
    room: fixtureRoom(mode, intensity),
    prefs: fixturePrefs(),
    history: [],
  });
  // System prompt is the first message; collapse for a single haystack.
  return msgs[0].content;
}

const TONES = ["brainstorm", "constructive", "debate", "research", "critique"] as const;
const INTENSITIES = ["calm", "sharp", "terse"] as const;

// Signature phrases each tone block MUST carry. Lifted from prompt.ts —
// re-grep these if the prompts get rewritten so the assertions track.
const TONE_SIGNATURES: Record<(typeof TONES)[number], string[]> = {
  brainstorm:    ["BRAINSTORM", "EXPAND THE POSSIBILITY SPACE", "Volume over polish", "YES-AND", "WILD"],
  constructive:  ["CONSTRUCTIVE", "stronger version", "load-bearing assumption"],
  debate:        ["DEBATE", "PRODUCTIVE DISAGREEMENT", "steelman", "Honest pass", "What would change my mind"],
  research:      ["RESEARCH", "OBSERVATION", "INFERENCE", "SPECULATION", "research instrument", "low/med/high"],
  critique:      ["CRITIQUE", "BLOCKER", "MAJOR", "minor", "audit"],
};

// Signature phrases for each intensity. Same approach.
const INTENSITY_SIGNATURES: Record<(typeof INTENSITIES)[number], string[]> = {
  calm:  ["CALM", "measured cadence", "Hedging where you're genuinely uncertain"],
  sharp: ["SHARP", "decisive cadence", "load-bearing claim in the first sentence"],
  terse: ["TERSE", "minimal cadence", "No hedging at all", "LENGTH dial, not the harshness dial"],
};

// HOUSE_ENGAGE_BY_TONE — the verbs threaded into the "engage" house rule.
const HOUSE_ENGAGE_FRAGMENTS: Record<(typeof TONES)[number], string> = {
  brainstorm:   "toss 3-6 ideas as a quick bulleted list",
  constructive: "pick a load-bearing assumption to sharpen",
  debate:       "steelman the target claim before attacking",
  research:     "cite a specific piece of material",
  critique:     "audit one specific load-bearing piece",
};

// TONE_OVERRIDE_BY_TONE — what trained-preference the OVERRIDE meta-line names.
const OVERRIDE_TARGETS: Record<(typeof TONES)[number], string> = {
  brainstorm:   "evaluate, critique, or anchor on the most recent idea",
  constructive: "diplomatically vague",
  debate:       "diplomatic middle ground",
  research:     "leap to recommendations",
  critique:     "soften criticism",
};

describe("buildDirectorMessages · tone × intensity matrix", () => {
  for (const tone of TONES) {
    for (const intensity of INTENSITIES) {
      it(`(${tone} × ${intensity}) carries the right blocks`, () => {
        const prompt = buildSystemPrompt(tone, intensity);

        // Tone block header is present and the right tone is named.
        expect(prompt).toContain(`─── TONE · ${tone.toUpperCase()} ───`);
        // Intensity block header is present and the right intensity is named.
        expect(prompt).toContain(`─── INTENSITY · ${intensity.toUpperCase()} ───`);

        // Every tone-signature phrase appears in the prompt body.
        for (const phrase of TONE_SIGNATURES[tone]) {
          expect(prompt).toContain(phrase);
        }
        // Every intensity-signature phrase appears.
        for (const phrase of INTENSITY_SIGNATURES[intensity]) {
          expect(prompt).toContain(phrase);
        }

        // HOUSE RULES "engage" line carries the tone-correct verbs.
        expect(prompt).toContain(HOUSE_ENGAGE_FRAGMENTS[tone]);

        // Closing OVERRIDE meta-line targets the tone-correct trained-bias.
        expect(prompt).toContain(OVERRIDE_TARGETS[tone]);

        // PERSONA OVERRIDE — every tone (after the bidirectional symmetry
        // change) ships a PERSONA OVERRIDE paragraph. Soft tones override
        // adversarial persona DNA; hard tones override consensus persona DNA.
        expect(prompt).toContain("PERSONA OVERRIDE");
      });
    }
  }
});

describe("buildDirectorMessages · tone normalization", () => {
  it("legacy 'no-mercy' mode normalizes to debate", () => {
    const prompt = buildSystemPrompt("no-mercy", "sharp");
    expect(prompt).toContain("─── TONE · DEBATE ───");
    expect(prompt).toContain("steelman");
  });

  it("unknown tone falls back to constructive guidance body", () => {
    const prompt = buildSystemPrompt("nonsense-tone", "sharp");
    // Header echoes the raw tone (uppercased) but the body is constructive.
    expect(prompt).toContain("─── TONE · NONSENSE-TONE ───");
    expect(prompt).toContain("CONSTRUCTIVE");
    expect(prompt).toContain("stronger version");
  });

  it("unknown intensity falls back to sharp guidance body", () => {
    const prompt = buildSystemPrompt("constructive", "deafening");
    expect(prompt).toContain("─── INTENSITY · DEAFENING ───");
    expect(prompt).toContain("decisive cadence"); // sharp's signature
  });

  it("legacy 'brutal' intensity normalizes to terse", () => {
    // Existing rooms / API clients carrying the old `brutal` value
    // should produce the same prompt body as `terse`. The header
    // reflects the normalized value (TERSE), not the raw input.
    const prompt = buildSystemPrompt("constructive", "brutal");
    expect(prompt).toContain("─── INTENSITY · TERSE ───");
    expect(prompt).toContain("minimal cadence");
    expect(prompt).toContain("LENGTH dial, not the harshness dial");
  });
});

describe("buildDirectorMessages · voice delivery mode", () => {
  it("injects colloquial roundtable guidance", () => {
    const speaker = fixtureAgent({ id: "speaker", name: "Speaker", handle: "@speaker" });
    const peer = fixtureAgent({ id: "peer", name: "Peer", handle: "@peer" });
    const room: Room = { ...fixtureRoom("constructive", "sharp"), deliveryMode: "voice" };
    const msgs = buildDirectorMessages({
      speaker,
      cast: [speaker, peer],
      room,
      prefs: fixturePrefs(),
      history: [],
      deliveryMode: "voice",
    });
    const prompt = msgs[0].content;
    expect(prompt).toContain("─── DELIVERY · VOICE MODE ───");
    expect(prompt).toContain("大白话");
    expect(prompt).toContain("ONE MOVE PER TURN");
    expect(prompt).toContain("Forbidden taxonomy tours");
    expect(prompt).toContain("115 English words");
    expect(msgs[msgs.length - 1].content).toContain("One move only");
  });
});

describe("parseRoundEndOutput · MODE-SHIFT extraction", () => {
  it("returns null modeShift when the chair omits the block", () => {
    const text = [
      "The room covered three angles on defensibility.",
      "",
      "POINTS:",
      "- moat assumption hangs on switching cost",
      "- distribution beat product in two cited cases",
      "- regulatory tailwind hasn't been priced in",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.points).toHaveLength(3);
    expect(out.modeShift).toBeNull();
    expect(out.ping).toContain("three angles");
  });

  it("extracts a valid MODE-SHIFT/BECAUSE pair and strips it from points", () => {
    const text = [
      "Round 3 mostly recombined existing candidates.",
      "",
      "POINTS:",
      "- six paths surfaced; no new branches in this round",
      "- candidate A is the load-bearing one",
      "- candidate D is the contrarian dark horse",
      "",
      "MODE-SHIFT: critique",
      "BECAUSE: brainstorm has produced six paths and the latest round only recombined them — time to audit which survives.",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.points).toHaveLength(3);
    expect(out.modeShift).not.toBeNull();
    expect(out.modeShift!.to).toBe("critique");
    expect(out.modeShift!.because).toContain("recombined");
    // The BECAUSE line must NOT have leaked into the points list.
    expect(out.points.every((p) => !/MODE-SHIFT|BECAUSE/i.test(p))).toBe(true);
  });

  it("rejects an unknown tone in the proposal", () => {
    const text = [
      "ping",
      "",
      "POINTS:",
      "- a",
      "- b",
      "- c",
      "",
      "MODE-SHIFT: salty",
      "BECAUSE: bogus tone name",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.points).toHaveLength(3);
    expect(out.modeShift).toBeNull();
  });

  it("rejects a proposal missing the BECAUSE line", () => {
    const text = [
      "ping",
      "",
      "POINTS:",
      "- a",
      "- b",
      "- c",
      "",
      "MODE-SHIFT: critique",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.modeShift).toBeNull();
  });

  it("trims a runaway BECAUSE to 240 chars", () => {
    const longReason = "x".repeat(500);
    const text = [
      "ping",
      "",
      "POINTS:",
      "- a",
      "- b",
      "- c",
      "",
      `MODE-SHIFT: research`,
      `BECAUSE: ${longReason}`,
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.modeShift).not.toBeNull();
    expect(out.modeShift!.because.length).toBeLessThanOrEqual(240);
  });

  it("falls back to bullet scan when chair forgets the POINTS: header", () => {
    // Small models occasionally drop the structure marker entirely
    // when the prompt is busy. Without a fallback, the user is locked
    // on the round-end skeleton because points = [].
    const text = [
      "The room landed on three threads.",
      "",
      "- moat assumption hangs on switching cost",
      "- distribution beat product in two cited cases",
      "- regulatory tailwind hasn't been priced in",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.points).toHaveLength(3);
    expect(out.points[0]).toContain("moat");
    expect(out.ping).toContain("three threads");
  });

  it("accepts numbered-list bullets (1. 2. 3.) and fullwidth colon", () => {
    const text = [
      "Round 2 surfaced three patterns.",
      "",
      "POINTS：",  // fullwidth colon
      "1. moat assumption hangs on switching cost",
      "2. distribution beat product in two cited cases",
      "3. regulatory tailwind hasn't been priced in",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.points).toHaveLength(3);
    expect(out.points[0]).toContain("moat");
  });

  it("survives MODE-SHIFT emitted BEFORE the POINTS block (regression)", () => {
    // The chair doesn't always honour the strict trailing-block layout
    // we ask for — sometimes it emits MODE-SHIFT first, then POINTS.
    // The original lazy regex anchored to end-of-string would swallow
    // the entire POINTS block into BECAUSE, leaving points = [] and
    // the round-end card stuck on its loading skeleton forever.
    const text = [
      "Round 3 mostly recombined existing candidates.",
      "",
      "MODE-SHIFT: critique",
      "BECAUSE: brainstorm exhausted; candidates need a fault audit now.",
      "",
      "POINTS:",
      "- six paths surfaced; no new branches in this round",
      "- candidate A is the load-bearing one",
      "- candidate D is the contrarian dark horse",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.points).toHaveLength(3);
    expect(out.points[0]).toContain("six paths");
    expect(out.modeShift?.to).toBe("critique");
  });

  it("handles markdown wrapping the tone (e.g. backticks)", () => {
    const text = [
      "ping",
      "",
      "POINTS:",
      "- a",
      "- b",
      "- c",
      "",
      "MODE-SHIFT: `debate`",
      "BECAUSE: positions hardened on opinion this round.",
    ].join("\n");
    const out = parseRoundEndOutput(text);
    expect(out.modeShift?.to).toBe("debate");
  });
});

describe("buildDirectorMessages · hard-tone PERSONA OVERRIDE coverage", () => {
  // The original code only had PERSONA OVERRIDE on the soft tones
  // (brainstorm / constructive / research). The bidirectional fix added
  // override paragraphs for debate and critique that target SOFT-leaning
  // persona DNA. Pin the new wording so a future edit doesn't quietly
  // drop one direction of the symmetry.
  it("debate targets consensus-seeking persona DNA", () => {
    const prompt = buildSystemPrompt("debate", "sharp");
    expect(prompt).toContain("PERSONA OVERRIDE");
    expect(prompt).toContain("softening, qualifying, building consensus");
  });

  it("critique targets empathic / mentor persona DNA", () => {
    const prompt = buildSystemPrompt("critique", "sharp");
    expect(prompt).toContain("PERSONA OVERRIDE");
    expect(prompt).toContain("softening criticism");
  });
});
