import { describe, expect, it } from "vitest";

import { insertAgent } from "../src/storage/agents.js";
import { createRoom, getRoom, listRoomMembers, listRooms, setRoomStatus } from "../src/storage/rooms.js";

function seedTwoAgents() {
  insertAgent({
    id: "soc", name: "Socrates", handle: "/socrates", roleTag: "skeptic",
    bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/a.svg",
  });
  insertAgent({
    id: "fp", name: "First Principles", handle: "/first_p", roleTag: "physicist",
    bio: "", instruction: "", modelV: "sonnet-4-6", avatarPath: "/b.svg",
  });
}

describe("rooms DAO", () => {
  it("auto-increments room.number starting at 1", () => {
    seedTwoAgents();
    const a = createRoom({ name: "first", subject: "x", agentIds: ["soc"] });
    const b = createRoom({ name: "second", subject: "y", agentIds: ["fp"] });
    expect(a.room.number).toBe(1);
    expect(b.room.number).toBe(2);
  });

  it("attaches members in the order given (position 0..N-1)", () => {
    seedTwoAgents();
    const { room } = createRoom({
      name: "ordered",
      subject: "moat",
      agentIds: ["fp", "soc"],
    });
    const members = listRoomMembers(room.id);
    expect(members[0]?.agentId).toBe("fp");
    expect(members[0]?.position).toBe(0);
    expect(members[1]?.agentId).toBe("soc");
    expect(members[1]?.position).toBe(1);
  });

  it("listRooms returns newest-first", async () => {
    seedTwoAgents();
    const a = createRoom({ name: "older", subject: "x", agentIds: ["soc"] });
    await new Promise((r) => setTimeout(r, 2));
    const b = createRoom({ name: "newer", subject: "y", agentIds: ["fp"] });
    const ids = listRooms().map((r) => r.id);
    expect(ids[0]).toBe(b.room.id);
    expect(ids[1]).toBe(a.room.id);
  });

  it("setRoomStatus flips live → adjourned with timestamp", () => {
    seedTwoAgents();
    const { room } = createRoom({ name: "z", subject: "y", agentIds: ["soc"] });
    setRoomStatus(room.id, "adjourned", { adjournedAt: 12345 });
    const fresh = getRoom(room.id)!;
    expect(fresh.status).toBe("adjourned");
    expect(fresh.adjournedAt).toBe(12345);
  });

  it("persists room delivery mode for voice meetings", () => {
    seedTwoAgents();
    const { room } = createRoom({
      name: "voice",
      subject: "slow the meeting down",
      agentIds: ["soc"],
      deliveryMode: "voice",
    });
    expect(room.deliveryMode).toBe("voice");
    expect(getRoom(room.id)?.deliveryMode).toBe("voice");
  });

  it("creating a room with an unknown agent still inserts (FK isn't validated by createRoom)", () => {
    // createRoom takes agentIds it trusts; route layer validates. So FK errors
    // surface as exceptions from SQLite. Confirm that path.
    expect(() =>
      createRoom({ name: "broken", subject: "x", agentIds: ["does-not-exist"] }),
    ).toThrow();
  });
});
