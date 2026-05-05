import { describe, expect, it } from "vitest";

import { parseSkillMd } from "../src/skills/parse.js";

const VALID = `---
name: First-Principles Reasoning
slug: first-principles
version: "1.0"
description: Strips problems to physical primitives.
when_to_use: When the question hides behind jargon or borrowed framings.
ability:
  rigor: 2
  decisiveness: -1
tips:
  - "Best with concrete problems."
  - "Pairs well with empirical-grounding."
---

# Body

Identify the smallest irreducible unit of the question, then rebuild.
`;

describe("parseSkillMd", () => {
  it("parses a valid skill", () => {
    const r = parseSkillMd(VALID);
    if (!r.ok) throw new Error("expected ok, got: " + r.error);
    expect(r.skill.slug).toBe("first-principles");
    expect(r.skill.name).toBe("First-Principles Reasoning");
    expect(r.skill.ability).toEqual({ rigor: 2, decisiveness: -1 });
    expect(r.skill.tips).toHaveLength(2);
    expect(r.skill.bodyMd).toContain("# Body");
    expect(r.skill.version).toBe("1.0");
  });

  it("rejects missing frontmatter", () => {
    const r = parseSkillMd("just markdown");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/frontmatter/);
  });

  it("rejects missing description", () => {
    const r = parseSkillMd(`---\nname: solo\n---\nbody`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/description/);
  });

  it("derives slug from name when slug is omitted (Claude Code style)", () => {
    const r = parseSkillMd(`---
name: First Principles Reasoning
description: Strips problems to physical primitives.
---

body`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.slug).toBe("first-principles-reasoning");
      expect(r.skill.whenToUse).toBe("Strips problems to physical primitives.");
    }
  });

  it("rejects bad slug", () => {
    const src = VALID.replace("first-principles", "Bad Slug!");
    const r = parseSkillMd(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slug/);
  });

  it("rejects unknown ability axis", () => {
    const src = VALID.replace("rigor: 2", "wisdom: 2");
    const r = parseSkillMd(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/wisdom/);
  });

  it("rejects out-of-range ability delta", () => {
    const src = VALID.replace("rigor: 2", "rigor: 7");
    const r = parseSkillMd(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/range/);
  });

  it("accepts a Claude Code-style minimal skill (just name + description)", () => {
    const src = `---
name: bare-skill
description: Minimal.
---

ok body`;
    const r = parseSkillMd(src);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.slug).toBe("bare-skill");
      expect(r.skill.whenToUse).toBe("Minimal.");
      expect(r.skill.ability).toEqual({});
      expect(r.skill.tips).toEqual([]);
    }
  });

  it("rejects empty input", () => {
    const r = parseSkillMd("");
    expect(r.ok).toBe(false);
  });
});
