import { describe, expect, it } from "vitest";

import { parseAgentSpec } from "../src/ai/prompts/agent-spec.js";
import {
  agentHandleLookupCandidates,
  bareHandleSlug,
  canonicalAgentHandleFromSlug,
  normalizeAgentHandleForStorage,
} from "../src/utils/agent-handle.js";

describe("parseAgentSpec · handle sigils stripped from model output", () => {
  const shell = {
    name: "Test Director",
    bio: "1234567890",
    instruction: "Speak clearly.",
  };

  it("strips leading / from handle", () => {
    const raw = JSON.stringify({ ...shell, handle: "/alpha_one" });
    expect(parseAgentSpec(raw)?.handle).toBe("alpha_one");
  });

  it("strips leading @ from handle", () => {
    const raw = JSON.stringify({ ...shell, handle: "@beta_gamma" });
    expect(parseAgentSpec(raw)?.handle).toBe("beta_gamma");
  });
});

describe("agent-handle · bareHandleSlug", () => {
  it("strips a single leading @", () => {
    expect(bareHandleSlug("@socrates")).toBe("socrates");
  });

  it("strips a single leading / (legacy)", () => {
    expect(bareHandleSlug("/socrates")).toBe("socrates");
  });

  it("collapses repeated sigils", () => {
    expect(bareHandleSlug("@@socrates")).toBe("socrates");
    expect(bareHandleSlug("//socrates")).toBe("socrates");
    expect(bareHandleSlug("@/socrates")).toBe("socrates");
    expect(bareHandleSlug("/@socrates")).toBe("socrates");
  });

  it("trims whitespace", () => {
    expect(bareHandleSlug("  @foo  ")).toBe("foo");
  });

  it("leaves slug without sigils untouched", () => {
    expect(bareHandleSlug("socrates")).toBe("socrates");
  });
});

describe("agent-handle · canonicalAgentHandleFromSlug", () => {
  it("prefixes bare slug with @", () => {
    expect(canonicalAgentHandleFromSlug("socrates")).toBe("@socrates");
  });

  it("normalises legacy slash input", () => {
    expect(canonicalAgentHandleFromSlug("/socrates")).toBe("@socrates");
  });

  it("throws on empty slug after stripping", () => {
    expect(() => canonicalAgentHandleFromSlug("")).toThrow(/empty/);
    expect(() => canonicalAgentHandleFromSlug("@")).toThrow(/empty/);
    expect(() => canonicalAgentHandleFromSlug("///")).toThrow(/empty/);
  });
});

describe("agent-handle · normalizeAgentHandleForStorage", () => {
  it("aliases normalize to canonical-from-slug", () => {
    expect(normalizeAgentHandleForStorage("first_p")).toBe("@first_p");
    expect(normalizeAgentHandleForStorage("@first_p")).toBe("@first_p");
    expect(normalizeAgentHandleForStorage("/first_p")).toBe("@first_p");
  });
});

describe("agent-handle · agentHandleLookupCandidates", () => {
  it("returns trimmed, @, and legacy / forms (deduped)", () => {
    expect(new Set(agentHandleLookupCandidates("@foo"))).toEqual(new Set(["@foo", "/foo"]));
  });

  it("includes the raw trimmed string when it differs (e.g. typo preservation)", () => {
    const c = agentHandleLookupCandidates(" @bar ");
    expect(c).toContain("@bar");
    expect(c).toContain("/bar");
  });

  it("returns [] for blank", () => {
    expect(agentHandleLookupCandidates("")).toEqual([]);
    expect(agentHandleLookupCandidates("  @  ")).toEqual([]);
  });
});
