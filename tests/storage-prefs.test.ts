import { describe, expect, it } from "vitest";

import { getPrefs, updatePrefs } from "../src/storage/prefs.js";

describe("prefs", () => {
  it("seeds a default row through migration 001", () => {
    const p = getPrefs();
    expect(p.name).toBe("You");
    expect(p.intro).toBe("");
    expect(p.theme).toBe("regent");
    expect(p.createdAt).toBeGreaterThan(0);
  });

  it("partial updates only touch the given fields", () => {
    updatePrefs({ name: "Kay" });
    expect(getPrefs().name).toBe("Kay");
    expect(getPrefs().theme).toBe("regent");

    updatePrefs({ theme: "atrium", intro: "thinking about flywheels" });
    const p = getPrefs();
    expect(p.name).toBe("Kay");
    expect(p.theme).toBe("atrium");
    expect(p.intro).toBe("thinking about flywheels");
  });

  it("updatedAt advances on writes", async () => {
    const before = getPrefs().updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    updatePrefs({ name: "K" });
    const after = getPrefs().updatedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
