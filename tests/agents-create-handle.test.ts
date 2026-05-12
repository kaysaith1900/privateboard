import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { agentsRouter } from "../src/routes/agents.js";
import { getAgentByHandle } from "../src/storage/agents.js";

describe("POST /api/agents · @ handle convention", () => {
  it("creates a director whose handle is @-prefixed (from name slug)", async () => {
    const app = new Hono();
    app.route("/api/agents", agentsRouter());

    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Handle Convention",
        bio: "12345678",
        instruction: "x",
        modelV: "sonnet-4-6",
        avatarPath: "/avatars/socrates.svg",
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as { handle: string };
    expect(created.handle).toMatch(/^@[a-z0-9_]+$/);
    expect(created.handle.startsWith("@")).toBe(true);
    expect(getAgentByHandle("handle_convention")?.handle).toBe(created.handle);
    expect(getAgentByHandle("@handle_convention")?.handle).toBe(created.handle);
  });
});
