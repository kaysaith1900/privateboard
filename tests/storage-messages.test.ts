import { describe, expect, it } from "vitest";

import { insertAgent } from "../src/storage/agents.js";
import {
  getCurrentRound,
  insertMessage,
  listMessages,
  listRecentMessages,
  nextUserRoundNum,
  updateMessageBody,
} from "../src/storage/messages.js";
import { createRoom } from "../src/storage/rooms.js";

function seed() {
  insertAgent({
    id: "soc", name: "Socrates", handle: "/socrates", roleTag: "skeptic",
    bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/a.svg",
  });
  return createRoom({ name: "t", subject: "x", agentIds: ["soc"] }).room.id;
}

describe("messages DAO", () => {
  it("nextUserRoundNum starts at 1, then bumps", () => {
    const id = seed();
    expect(nextUserRoundNum(id)).toBe(1);
    insertMessage({ roomId: id, authorKind: "user", body: "first", roundNum: 1 });
    expect(getCurrentRound(id)).toBe(1);
    expect(nextUserRoundNum(id)).toBe(2);
    insertMessage({ roomId: id, authorKind: "agent", authorId: "soc", body: "reply", roundNum: 1 });
    expect(nextUserRoundNum(id)).toBe(2);
    insertMessage({ roomId: id, authorKind: "user", body: "second", roundNum: 2 });
    expect(nextUserRoundNum(id)).toBe(3);
  });

  it("listMessages returns chronological; listRecent returns the tail", async () => {
    const id = seed();
    insertMessage({ roomId: id, authorKind: "user", body: "a" });
    await new Promise((r) => setTimeout(r, 2));
    insertMessage({ roomId: id, authorKind: "user", body: "b" });
    await new Promise((r) => setTimeout(r, 2));
    insertMessage({ roomId: id, authorKind: "user", body: "c" });
    const all = listMessages(id);
    expect(all.map((m) => m.body)).toEqual(["a", "b", "c"]);
    const recent = listRecentMessages(id, 2);
    expect(recent.map((m) => m.body)).toEqual(["b", "c"]);
  });

  it("updateMessageBody mutates body and meta", () => {
    const id = seed();
    const m = insertMessage({ roomId: id, authorKind: "agent", authorId: "soc", body: "draft", meta: { speakerStatus: "streaming" } });
    updateMessageBody(m.id, "final body", { speakerStatus: "final", streaming: false });
    const fresh = listMessages(id).find((x) => x.id === m.id);
    expect(fresh?.body).toBe("final body");
    expect(fresh?.meta.speakerStatus).toBe("final");
    expect(fresh?.meta.streaming).toBe(false);
  });

  it("meta_json roundtrips JSON correctly", () => {
    const id = seed();
    insertMessage({
      roomId: id,
      authorKind: "user",
      body: "hi",
      meta: { mentions: ["soc", "fp"], custom: { nested: true } },
    });
    const m = listMessages(id)[0]!;
    expect(m.meta.mentions).toEqual(["soc", "fp"]);
    expect((m.meta.custom as { nested: boolean }).nested).toBe(true);
  });
});
