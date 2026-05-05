import { describe, expect, it } from "vitest";

import { newId } from "../src/utils/id.js";

describe("newId", () => {
  it("returns the requested length, default 12", () => {
    expect(newId()).toHaveLength(12);
    expect(newId(8)).toHaveLength(8);
    expect(newId(20)).toHaveLength(20);
  });

  it("only uses the readable lowercase + digit alphabet (no i, l, o, u)", () => {
    const id = newId(200);
    expect(/^[0-9abcdefghjkmnpqrstvwxyz]+$/.test(id)).toBe(true);
  });

  it("is unique across many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newId());
    expect(seen.size).toBe(1000);
  });
});
