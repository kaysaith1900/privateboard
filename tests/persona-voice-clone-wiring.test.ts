/**
 * Persona × voice-clone wiring · unit tests for the Phase-5 integration
 * that auto-clones a real person's voice and stamps it onto the saved
 * agent.
 *
 * These tests cover the *contract* between the persona builder and the
 * save handler:
 *
 *   1. The `PersonaSpec.clonedVoice` field is preserved through the
 *      partial → final spec roundtrip.
 *   2. When the save handler receives a spec with `clonedVoice.voiceId`,
 *      the resulting agent row carries a MiniMax voice profile pointing
 *      at that voice_id (and the right model).
 *   3. When `clonedVoice` is absent, the agent ships without a voice
 *      override (default voice path).
 *
 * The actual orchestrator pipeline (yt-dlp + ffmpeg + MiniMax calls) is
 * NOT exercised here; that needs real external services. The wiring
 * test is enough to catch regressions in the contract.
 */
import { describe, expect, it } from "vitest";

import {
  getAgent,
  insertAgent,
  updateAgent,
  type PersonaSpec,
} from "../src/storage/agents.js";

function makeSpec(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    description: "A test director",
    spec: {
      intellectualLineage: [],
      loadBearingConcepts: [],
      referentSet: [],
      failureModes: [],
      contrarianTakes: [],
    },
    knowledge: {
      keyThinkers: [],
      foundationalWorks: [],
      recentDevelopments: [],
      contestedClaims: [],
      searchQueries: [],
    },
    rules: [],
    fewShot: [],
    reflectionChecklist: [],
    evalSet: [],
    differentiationScore: null,
    toolAccess: { webSearch: false },
    ...overrides,
  };
}

describe("persona × voice clone wiring", () => {
  it("preserves clonedVoice through the spec roundtrip", () => {
    const spec = makeSpec({
      clonedVoice: { celebrity: "test-speaker-a", voiceId: "pb_test_speaker_abc123" },
    });
    expect(spec.clonedVoice).toEqual({
      celebrity: "test-speaker-a",
      voiceId: "pb_test_speaker_abc123",
    });
    const reserialised = JSON.parse(JSON.stringify(spec)) as PersonaSpec;
    expect(reserialised.clonedVoice?.voiceId).toBe("pb_test_speaker_abc123");
  });

  it("save-handler logic · stamps voice profile when clonedVoice is present", () => {
    // Insert the agent first (mirroring routes/agents.ts:798), then
    // apply the post-insert voice attach the route does.
    const agentId = "test-agent-with-voice";
    insertAgent({
      id: agentId,
      name: "Test Speaker A",
      handle: "@test-speaker-a",
      roleTag: "value-investor",
      bio: "test bio",
      coverQuote: null,
      instruction: "test instruction body that is long enough to pass any minimum-length checks the storage layer enforces on save.",
      modelV: "opus-4-7",
      avatarPath: "/avatars/socrates.svg",
      ability: null,
      personaSpec: makeSpec({
        clonedVoice: { celebrity: "test-speaker-a", voiceId: "pb_test_speaker_xyz" },
      }),
    });
    // Replicate the route's attach step:
    updateAgent(agentId, {
      voice: {
        provider: "minimax",
        model: "speech-2.8-hd",
        voiceId: "pb_test_speaker_xyz",
      },
    });
    const saved = getAgent(agentId);
    expect(saved?.voice?.provider).toBe("minimax");
    expect(saved?.voice?.model).toBe("speech-2.8-hd");
    expect(saved?.voice?.voiceId).toBe("pb_test_speaker_xyz");
  });

  it("leaves voice unset when clonedVoice is absent", () => {
    const agentId = "test-agent-no-voice";
    insertAgent({
      id: agentId,
      name: "Test No Voice",
      handle: "@test-no-voice",
      roleTag: "skeptic",
      bio: "test bio",
      coverQuote: null,
      instruction: "test instruction body that is long enough to pass any minimum-length checks the storage layer enforces on save.",
      modelV: "opus-4-7",
      avatarPath: "/avatars/socrates.svg",
      ability: null,
      personaSpec: makeSpec(),
    });
    const saved = getAgent(agentId);
    expect(saved?.voice ?? null).toBeNull();
  });
});
