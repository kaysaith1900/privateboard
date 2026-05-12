import { describe, expect, it } from "vitest";

import agentHandleAt035 from "../src/storage/migrations/035_agent_handle_at_prefix.sql";
import { getAgent, getAgentByHandle, insertAgent } from "../src/storage/agents.js";
import { getDb } from "../src/storage/db.js";

/**
 * Migration `035_agent_handle_at_prefix.sql` · rewrites persisted `/slug`
 * agent handles to `@slug` for installs that upgraded from the legacy convention.
 * Application startup runs this via `runMigrations()` — operators do not run a
 * separate shell script.
 */
describe("migration 035_agent_handle_at_prefix", () => {
  it("UPDATE rewrites /handle column to @handle", () => {
    insertAgent({
      id: "mig-up",
      name: "Upgrade Me",
      handle: "/needs_at_prefix",
      roleTag: "test",
      bio: "12345678",
      instruction: "x",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/socrates.svg",
    });

    expect(getAgent("mig-up")?.handle).toBe("/needs_at_prefix");

    getDb().exec(agentHandleAt035 as string);

    expect(getAgent("mig-up")?.handle).toBe("@needs_at_prefix");
    expect(getAgentByHandle("/needs_at_prefix")?.id).toBe("mig-up");
    expect(getAgentByHandle("@needs_at_prefix")?.id).toBe("mig-up");
  });

  it("skips rewrite when @target would collide with another row", () => {
    insertAgent({
      id: "mig-a",
      name: "A",
      handle: "@collision_slug",
      roleTag: "",
      bio: "12345678",
      instruction: "x",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/socrates.svg",
    });
    insertAgent({
      id: "mig-b",
      name: "B",
      handle: "/collision_slug",
      roleTag: "",
      bio: "12345678",
      instruction: "x",
      modelV: "sonnet-4-6",
      avatarPath: "/avatars/socrates.svg",
    });

    getDb().exec(agentHandleAt035 as string);

    expect(getAgent("mig-a")?.handle).toBe("@collision_slug");
    expect(getAgent("mig-b")?.handle).toBe("/collision_slug");
  });
});
