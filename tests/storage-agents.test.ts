import { describe, expect, it } from "vitest";

import { countAgents, getAgent, getAgentByHandle, insertAgent, listAgents, updateAgent } from "../src/storage/agents.js";

describe("agents DAO", () => {
  it("starts empty and counts inserts", () => {
    expect(countAgents()).toBe(0);
    insertAgent({
      id: "test1",
      name: "Test One",
      handle: "/t1",
      roleTag: "skeptic",
      bio: "questions everything",
      instruction: "system prompt",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/t1.svg",
      isPinned: false,
      isSeed: true,
    });
    expect(countAgents()).toBe(1);
  });

  it("getAgent returns by id, getAgentByHandle by handle", () => {
    insertAgent({
      id: "soc",
      name: "Socrates",
      handle: "/socrates",
      roleTag: "skeptic",
      bio: "",
      instruction: "",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/socrates.svg",
    });
    expect(getAgent("soc")?.name).toBe("Socrates");
    expect(getAgentByHandle("/socrates")?.id).toBe("soc");
    expect(getAgent("nope")).toBeNull();
    expect(getAgentByHandle("/nope")).toBeNull();
  });

  it("listAgents puts pinned first, then chronological", () => {
    insertAgent({
      id: "a", name: "A", handle: "/a", roleTag: "", bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/a.svg",
    });
    insertAgent({
      id: "b", name: "B", handle: "/b", roleTag: "", bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/b.svg",
      isPinned: true,
    });
    insertAgent({
      id: "c", name: "C", handle: "/c", roleTag: "", bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/c.svg",
    });
    const order = listAgents().map((a) => a.id);
    expect(order[0]).toBe("b");        // pinned wins
    expect(order.includes("a")).toBe(true);
    expect(order.includes("c")).toBe(true);
  });

  it("rejects duplicate handles via UNIQUE constraint", () => {
    insertAgent({
      id: "x1", name: "X", handle: "/x", roleTag: "", bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/x.svg",
    });
    expect(() =>
      insertAgent({
        id: "x2", name: "X2", handle: "/x", roleTag: "", bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/x2.svg",
      }),
    ).toThrow();
  });

  it("persists per-agent voice profile", () => {
    insertAgent({
      id: "voice-agent",
      name: "Voice Agent",
      handle: "/voice_agent",
      roleTag: "operator",
      bio: "speaks in short sentences",
      instruction: "system prompt",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/socrates.svg",
    });

    const updated = updateAgent("voice-agent", {
      voice: {
        provider: "minimax",
        model: "speech-2.8-turbo",
        voiceId: "Chinese_Refreshing_Young_Man",
        speed: 1.05,
        pitch: 0,
        volume: 1,
        instructions: "Calm, concise boardroom voice.",
      },
    });

    expect(updated?.voice?.provider).toBe("minimax");
    expect(updated?.voice?.voiceId).toBe("Chinese_Refreshing_Young_Man");
    expect(getAgent("voice-agent")?.voice?.model).toBe("speech-2.8-turbo");
  });
});
