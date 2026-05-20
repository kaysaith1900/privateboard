/**
 * Voice reshuffle helper · fires when the active voice credential
 * changes in a way that invalidates per-agent voice profiles. Two
 * trigger paths converge here:
 *
 *   1. `first-key` · the user just added their FIRST voice credential
 *      (0 → 1 voice credentials configured). Every agent gets a
 *      fresh voice from the new provider's catalog so the deck
 *      sounds distinguishable in TTS out of the box.
 *
 *   2. `provider-switch` · the active credential changed to one
 *      whose provider differs from the prior active's provider.
 *      Stored agent voice ids belong to the OLD provider and would
 *      404 at synthesis time against the new provider's API · we
 *      reshuffle to fresh ids from the new provider's catalog.
 *
 * Same-provider switches (e.g. MiniMax-key-A → MiniMax-key-B) do
 * NOT reach this helper — voice ids are stable per provider, and
 * the user's per-agent picks remain valid. The route layer gates
 * this decision before invoking us.
 *
 * Last credential deleted → caller passes `reason: "provider-switch"`
 * with the active resolution returning null; we clear every agent's
 * voice profile so synthesis falls back to browser.
 *
 * SIM-swap memory · when `opts.priorProvider` is set, every agent's
 * current `voice` is snapshotted into `voice_by_provider[priorProvider]`
 * BEFORE we overwrite it. On the restore side, if a bucket entry
 * exists for the new target provider, that profile is honoured
 * verbatim instead of picking from the static seed pool · the user's
 * manual per-director voice picks survive any number of provider
 * round-trips.
 *
 * Replaces the older `autoAssignVoicesOnFirstKey` in
 * `src/routes/keys.ts` · single entry point for both flows so the
 * logic can't drift.
 */
import {
  getVoiceBucket,
  listAllAgents,
  updateAgent,
  writeVoiceBucketEntry,
  type AgentVoiceProfile,
  type AgentVoiceProvider,
} from "./agents.js";
import { getActiveVoiceProvider, type VoiceProvider } from "./voice-credentials.js";

/** Static voice pools per provider · matches the constants in
 *  `src/voice/registry.ts` (MINIMAX_SYSTEM_VOICES + ELEVENLABS_DEFAULT_VOICES).
 *  Duplicated here to keep `reconcile-voices.ts` free of the
 *  network-fetching catalog code · we only need the SEED set for
 *  initial assignment, the live catalog isn't required. */
const MINIMAX_SEED_VOICES: Array<{ provider: AgentVoiceProvider; model: string; voiceId: string }> = [
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-qingse" },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-shaonv" },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-yujie" },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-jingying" },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-chengshu" },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-tianmei" },
];

const ELEVENLABS_SEED_VOICES: Array<{ provider: AgentVoiceProvider; model: string; voiceId: string }> = [
  { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "21m00Tcm4TlvDq8ikWAM" },
  { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
];

export interface ReconcileVoicesOpts {
  /** Provenance for the log line · NOT used for branching (both
   *  paths run the same algorithm). */
  reason: "first-key" | "provider-switch";
  /** The active voice provider BEFORE the caller flipped prefs to the
   *  new one. When set, we snapshot every agent's CURRENT `voice` into
   *  `voice_by_provider[priorProvider]` before reshuffling — so a
   *  subsequent switch back to `priorProvider` restores the user's
   *  manual picks exactly. When undefined / null (first-key path,
   *  or boot self-heal), no snapshot runs. */
  priorProvider?: VoiceProvider | null;
}

export interface ReconcileVoicesResult {
  changed: number;
  cleared: number;
  reason: ReconcileVoicesOpts["reason"];
  toProvider: AgentVoiceProvider | null;
}

/** Fisher-Yates · in-place shuffle. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Snapshot helper · stash the agent's CURRENT voice into the bucket
 *  for the prior provider. Only credentialed-provider voices land in
 *  the bucket (writeVoiceBucketEntry filters internally), so a
 *  browser-fallback or openai voice is silently skipped — those are
 *  fallbacks, not SIM cards. */
function snapshotPrior(
  agent: { id: string; voice: AgentVoiceProfile | null },
  priorProvider: VoiceProvider | null | undefined,
  targetProvider: VoiceProvider | null,
): void {
  if (!priorProvider) return;
  if (priorProvider === targetProvider) return;
  if (!agent.voice) return;
  if (agent.voice.provider !== priorProvider) return;
  try { writeVoiceBucketEntry(agent.id, priorProvider, agent.voice); }
  catch (e) {
    process.stderr.write(
      `[reconcile-voices] snapshot failed for ${agent.id}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/** Run the reshuffle. Reads the CURRENTLY-active voice provider via
 *  `getActiveVoiceProvider()` (i.e. the caller has already updated
 *  prefs before invoking us). Returns counts for the audit log. */
export function reconcileAgentVoices(opts: ReconcileVoicesOpts): ReconcileVoicesResult {
  const targetProvider = getActiveVoiceProvider();
  const priorProvider = opts.priorProvider ?? null;
  const agents = listAllAgents();
  if (agents.length === 0) {
    return { changed: 0, cleared: 0, reason: opts.reason, toProvider: targetProvider };
  }

  // No active provider → clear every agent's voice profile so
  // synthesis falls back to browser. Snapshot to the prior provider's
  // bucket FIRST so the user's manual picks survive even when they
  // delete the last voice credential and add one back later.
  if (!targetProvider) {
    let cleared = 0;
    for (const a of agents) {
      snapshotPrior(a, priorProvider, null);
      if (a.voice) {
        try { updateAgent(a.id, { voice: null }); cleared++; }
        catch (e) {
          process.stderr.write(
            `[reconcile-voices] clear failed for ${a.id}: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    }
    process.stderr.write(`[reconcile-voices] reason=${opts.reason} toProvider=null cleared=${cleared}\n`);
    return { changed: 0, cleared, reason: opts.reason, toProvider: null };
  }

  // Pick the static seed pool for the new provider · used only when
  // the bucket has no entry for this agent on the new provider.
  const pool = targetProvider === "minimax"
    ? MINIMAX_SEED_VOICES
    : targetProvider === "elevenlabs"
      ? ELEVENLABS_SEED_VOICES
      : [];
  if (pool.length === 0) {
    process.stderr.write(`[reconcile-voices] reason=${opts.reason} toProvider=${targetProvider} no-pool · skipped\n`);
    return { changed: 0, cleared: 0, reason: opts.reason, toProvider: targetProvider };
  }

  // Shuffle so different deployments get different default-deck
  // permutations. Distinct-per-agent up to pool.length; agents
  // beyond that wrap.
  const shuffled = shuffle([...pool]);

  let changed = 0;
  // Narrow targetProvider for the bucket lookup · `getActiveVoiceProvider`
  // returns VoiceProvider | null, and we already short-circuited null
  // above, so targetProvider is exactly VoiceProvider here.
  const targetVp: VoiceProvider = targetProvider;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

    // PHASE 1 · snapshot the prior provider's voice into the bucket
    // BEFORE we overwrite the agent's row.
    snapshotPrior(a, priorProvider, targetVp);

    // PHASE 2 · restore from bucket when possible. Bucket entries are
    // always reachable by construction (key === voice.provider), so
    // no reachability check is needed. We still merge user-tuned
    // dials from the current voice (a fresh provider switch may have
    // happened after the user adjusted speed/pitch under the new
    // provider's interim default — keep those tweaks).
    const bucket = getVoiceBucket(a.id);
    const memorised = bucket[targetVp];
    const prev = a.voice;

    let profile: AgentVoiceProfile;
    if (memorised) {
      // Bucket hit · honour the user's prior pick on this provider
      // verbatim, but adopt any newer fine-tune dials the user has
      // applied since the snapshot (they wanted those values, even
      // if they were applied to a different voice).
      profile = {
        provider: memorised.provider,
        model: memorised.model,
        voiceId: memorised.voiceId,
        ...(prev?.speed !== undefined ? { speed: prev.speed } : (memorised.speed !== undefined ? { speed: memorised.speed } : {})),
        ...(prev?.pitch !== undefined ? { pitch: prev.pitch } : (memorised.pitch !== undefined ? { pitch: memorised.pitch } : {})),
        ...(prev?.volume !== undefined ? { volume: prev.volume } : (memorised.volume !== undefined ? { volume: memorised.volume } : {})),
        ...(prev?.emotion !== undefined ? { emotion: prev.emotion } : (memorised.emotion !== undefined ? { emotion: memorised.emotion } : {})),
        ...(memorised.modifyPitch !== undefined ? { modifyPitch: memorised.modifyPitch } : {}),
        ...(memorised.modifyIntensity !== undefined ? { modifyIntensity: memorised.modifyIntensity } : {}),
        ...(memorised.modifyTimbre !== undefined ? { modifyTimbre: memorised.modifyTimbre } : {}),
        ...(memorised.instructions !== undefined ? { instructions: memorised.instructions } : {}),
      };
    } else {
      // Bucket miss · use the static seed pool. Skip when the agent
      // already has a matching-provider voice and `reason` is
      // "first-key" — they were set up before the SIM-swap path
      // existed and should keep their pick (also seed the bucket so
      // a subsequent round-trip restores it).
      if (opts.reason === "first-key" && a.voice && a.voice.provider === targetVp) {
        if (!bucket[targetVp]) {
          try { writeVoiceBucketEntry(a.id, targetVp, a.voice); }
          catch (e) {
            process.stderr.write(
              `[reconcile-voices] seed failed for ${a.id}: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
        }
        continue;
      }
      const pick = shuffled[i % shuffled.length];
      profile = {
        provider: pick.provider,
        model: pick.model,
        voiceId: pick.voiceId,
        ...(prev?.speed !== undefined ? { speed: prev.speed } : {}),
        ...(prev?.pitch !== undefined ? { pitch: prev.pitch } : {}),
        ...(prev?.volume !== undefined ? { volume: prev.volume } : {}),
        ...(prev?.emotion !== undefined ? { emotion: prev.emotion } : {}),
      };
    }

    try {
      updateAgent(a.id, { voice: profile });
      writeVoiceBucketEntry(a.id, targetVp, profile);
      changed++;
    } catch (e) {
      process.stderr.write(
        `[reconcile-voices] update failed for ${a.id}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  process.stderr.write(
    `[reconcile-voices] reason=${opts.reason} toProvider=${targetProvider} changed=${changed}\n`,
  );
  return { changed, cleared: 0, reason: opts.reason, toProvider: targetProvider };
}
