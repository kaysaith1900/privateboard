import { describe, expect, it } from "vitest";

import { buildBriefMessages, extractBriefTitle } from "../src/ai/prompts/brief.js";

describe("extractBriefTitle", () => {
  it("returns the first H2 that isn't a section heading", () => {
    const md = [
      "## Where defensibility lives in AI-native HR tech",
      "",
      "## Situation",
      "...",
    ].join("\n");
    expect(extractBriefTitle(md, "fallback")).toBe("Where defensibility lives in AI-native HR tech");
  });

  it("ignores 'Situation' / 'Findings' / 'Implication' as titles", () => {
    const md = ["## Situation", "..."].join("\n");
    expect(extractBriefTitle(md, "fallback subject")).toBe("fallback subject");
  });

  it("falls back when the brief is empty or malformed", () => {
    expect(extractBriefTitle("", "Q")).toBe("Q");
    expect(extractBriefTitle("plain prose with no header", "Q")).toBe("Q");
  });
});

describe("buildBriefMessages", () => {
  const room = {
    id: "r1",
    number: 1,
    name: "test",
    subject: "is data the moat?",
    mode: "discovery",
    status: "live" as const,
    briefStyle: null,
    createdAt: 0,
    adjournedAt: null,
  };
  const members = [
    { id: "socrates", name: "Socrates", handle: "@socrates", roleTag: "skeptic", bio: "doubt", coverQuote: null, instruction: "", modelV: "sonnet-4-6", avatarPath: "/a.svg", isPinned: false, isSeed: true, createdAt: 0, updatedAt: 0 },
  ];
  const transcript = [
    { id: "m1", roomId: "r1", authorKind: "user" as const, authorId: null, replyToId: null, body: "hello", meta: {}, roundNum: 1, createdAt: 0 },
    { id: "m2", roomId: "r1", authorKind: "agent" as const, authorId: "socrates", replyToId: "m1", body: "which moat?", meta: {}, roundNum: 1, createdAt: 1 },
  ];

  it("returns [system, user] with the transcript embedded", () => {
    const msgs = buildBriefMessages({ room, members, transcript, style: "mckinsey" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("is data the moat?");
    expect(msgs[1]?.content).toContain("hello");
    expect(msgs[1]?.content).toContain("which moat?");
    expect(msgs[1]?.content).toContain("Socrates");
  });

  it("system prompt mentions the three required sections", () => {
    const msgs = buildBriefMessages({ room, members, transcript, style: "mckinsey" });
    const system = msgs[0]!.content;
    expect(system).toMatch(/Situation/);
    expect(system).toMatch(/Findings/);
    expect(system).toMatch(/Implication/);
  });
});
