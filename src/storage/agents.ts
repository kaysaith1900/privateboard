/** Directors / agents. */
import { agentHandleLookupCandidates } from "../utils/agent-handle.js";
import { getDb } from "./db.js";
import type { BuildEvent } from "../orchestrator/persona-stream.js";
import type { VoiceProvider } from "./voice-credentials.js";

export type AgentRoleKind = "director" | "moderator";

/** Optional per-agent carrier override. The same modelV may be reachable
 *  via multiple carriers when the user has multiple provider keys (e.g.
 *  GPT-5.5 via OpenRouter or via OpenAI direct). The adapter's default
 *  precedence rules pick one; this lets each agent pin a specific carrier.
 *  NULL = "use default precedence". */
export type AgentCarrierPref = "openrouter" | "bai" | "anthropic" | "openai" | "google" | "xai" | "moonshot" | "zhipu";
const VALID_CARRIER_PREFS: ReadonlySet<AgentCarrierPref> = new Set([
  "openrouter", "bai", "anthropic", "openai", "google", "xai", "moonshot", "zhipu",
]);
function parseCarrierPref(raw: string | null): AgentCarrierPref | null {
  if (!raw) return null;
  return VALID_CARRIER_PREFS.has(raw as AgentCarrierPref)
    ? (raw as AgentCarrierPref)
    : null;
}

/** Per-director 3D-avatar config built in the "捏 avatar" editor. The four
 *  id fields select a body style + independent hair / clothing / accessory
 *  dimensions (ids from the avatar-3d.js *_STYLES / *_MODELS registries); the
 *  four colour fields are `#rrggbb`. Persisted to `agents.avatar3d_json`;
 *  NULL → the room derives a deterministic per-id default. */
export interface Avatar3dConfig {
  model: string;
  hairStyle: string;
  accessory: string;
  skin: string;
  hair: string;
  brow: string;
  /** Legacy combined outfit fields. Kept optional for back-compat with
   *  configs saved before the outfit split — the frontend treats them as
   *  fallbacks for top/bottom when those are absent. New saves no longer
   *  include them. */
  outfitStyle?: string;
  outfit?: string;
  /** Top / bottom split (上衣 / 裤子). Each is a model id whose role "top"
   *  or "bottom" meshes get overlaid. Optional only for back-compat. */
  topStyle?: string;
  bottomStyle?: string;
  top?: string;
  bottom?: string;
  /** Optional · eyebrow-shape source ("default" = own) and tie source
   *  ("none" = no tie). Absent on configs saved before these dimensions
   *  existed — treated as "default" / "none". */
  browStyle?: string;
  /** Optional · eye-shape source ("default" = own). Overlays that model's
   *  eye mesh. Absent on older configs — treated as "default". */
  eyeStyle?: string;
  tieStyle?: string;
  /** Optional · beard source ("none" = no beard) + beard colour. */
  beardStyle?: string;
  beard?: string;
  /** Optional · neckwear (tie / bow) colour `#rrggbb`. */
  tie?: string;
  /** Optional · iris / pupil colour `#rrggbb`. */
  eye?: string;
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  roleTag: string;
  roleKind: AgentRoleKind;
  bio: string;
  coverQuote: string | null;
  instruction: string;
  modelV: string;
  /** Carrier override — see AgentCarrierPref. NULL keeps the default
   *  routing precedence (OR-only models prefer OR; otherwise direct). */
  carrierPref: AgentCarrierPref | null;
  avatarPath: string;
  /** Base ability profile · {axis: 0-10}. NULL when not set (legacy
   *  records); the radar falls back to flat 5/all. */
  ability: Record<string, number> | null;
  isPinned: boolean;
  isSeed: boolean;
  /** Per-agent toggle for the Web Search system skill. Defaults to
   *  true. The actual gate is the user-supplied Brave Search key in
   *  provider_keys — without that key, no agent searches regardless
   *  of this flag. */
  webSearchEnabled: boolean;
  voice: AgentVoiceProfile | null;
  /** Full-persona artifact when the agent was built via the deep
   *  persona-builder pipeline (`mode === 'full'`). Null on every
   *  Signal-mode agent and on every seeded director. The runtime
   *  injection of few-shot examples + reflection checklist into
   *  director system prompts is gated on this field — see
   *  `src/orchestrator/prompt.ts:buildDirectorMessages`. */
  personaSpec: PersonaSpec | null;
  /** User-authored hard rules typed in the agent profile (e.g.
   *  "不要谈及范冰冰"). Distinct from `personaSpec.rules` (LLM-generated
   *  behavioural rules): these are explicit user directives that the
   *  orchestrator injects into the director's turn prompt as hard
   *  constraints — see `src/orchestrator/prompt.ts`. Empty array when
   *  the user set none. Persisted to `agents.user_rules_json`. */
  userRules: string[];
  /** 3D-avatar config from the "捏 avatar" editor. NULL when the director
   *  has never been customized — the voice room then renders a deterministic
   *  per-id default. Persisted to `agents.avatar3d_json`. */
  avatar3d: Avatar3dConfig | null;
  createdAt: number;
  updatedAt: number;
}

/** Schema for the deep-persona artifact persisted to
 *  `agents.persona_spec_json`. Each Full-mode build produces exactly
 *  one of these; the artifact is also rendered as a downloadable
 *  Markdown doc via `GET /api/agents/:id/persona.md`.
 *
 *  Versioned so future schema migrations can be parsed defensively —
 *  unknown / missing fields default to null and the runtime injection
 *  helpers degrade gracefully (skip that block, render the rest). */
export interface PersonaSpec {
  /** Schema version · bump when fields change shape so older readers
   *  can detect mismatches and fall back to ignoring the artifact. */
  version: 1;
  /** ISO-8601 timestamp of the build. Surfaces in the MD export's
   *  header line so the user can tell when this persona was made. */
  generatedAt: string;
  /** What the user typed into the composer to kick the build. Kept
   *  for the MD export's "built from" attribution + future re-builds. */
  description: string;
  /** Short content summary of phases 1+3 (intellectual lineage etc.).
   *  Mirror of the existing `AgentProfile` shape from agent-spec.ts so
   *  the synthesizer that compiles `instruction` from this can re-use
   *  the same helpers. */
  spec: PersonaSpecCore;
  /** Phase-2 ReAct loop output · structured knowledge with citations. */
  knowledge: PersonaKnowledge;
  /** Phase-4 · ranked behavioural rules. Always / Never / When X do Y. */
  rules: PersonaRule[];
  /** Phase-5 · 3-5 worked examples that distill voice. Injected into
   *  the per-turn system prompt for Full-mode agents. */
  fewShot: PersonaFewShot[];
  /** Phase-6 · 5-8 questions the agent silently runs before speaking.
   *  Injected at the END of the per-turn system prompt. */
  reflectionChecklist: string[];
  /** Phase-7 · test prompts + per-prompt differentiation scores from
   *  the build-time eval. The header score is surfaced on the save
   *  card AND in the MD export. */
  evalSet: PersonaEvalEntry[];
  /** Optional · the cumulative differentiation score (mean across
   *  evalSet). Null when the build skipped the eval pass (e.g. no
   *  embedding model reachable). */
  differentiationScore: number | null;
  /** Per-tool recommendation surfaced from spec generation. Currently
   *  only `webSearch` because that's the only system skill that has a
   *  per-agent toggle. Future skills extend this map. */
  toolAccess: { webSearch: boolean };
  /** Optional · build-time guess at a director name produced by a
   *  small post-pipeline naming pass. The save form prefills this in
   *  the name field. Older completed jobs may not carry it; the route
   *  layer falls back to the seed-words heuristic when missing. */
  guessName?: string;
  /** Optional · narrative + structured log of what the build pipeline
   *  did, captured at every `personaBus.emit` site in the orchestrator
   *  and capped with a short LLM-written summary at phase-7 end.
   *  Surfaced on the agent profile as the "Build log" modal. Older
   *  agents (built before this field existed) and Signal-mode agents
   *  carry `undefined` here — the UI hides the entry point when so. */
  buildLog?: PersonaBuildLog;
}

/** What the build-log modal renders: a human-readable narrative plus
 *  the structured event timeline. The narrative is generated in the
 *  user's locale at build time; we don't re-translate later because
 *  the events themselves carry no locale-sensitive strings beyond what
 *  the LLM produced. */
export interface PersonaBuildLog {
  /** 200–400 word pitch-style summary the narrator pass produces. Plain
   *  language only — no "multi-dimensional retrieval" or "ReAct loop"
   *  jargon — generated by `src/orchestrator/persona-narrator.ts`. May
   *  be the empty string if the narrator call failed; the modal still
   *  renders the timeline. */
  narrative: string;
  /** Locale the narrative is written in. Matches the locale the user
   *  had selected when they kicked the build. */
  locale: "en" | "zh" | "ja" | "es";
  /** Epoch-ms when the narrator finished. */
  generatedAt: number;
  /** Append-only timeline of every meaningful event during the build,
   *  in chronological order. The modal walks these to render the
   *  7-phase rail + the dimension-card grid under phase 2. */
  events: BuildEvent[];
  /** Cumulative tokens the build spent · sum of prompt + completion
   *  across every phase. Shown as a small stat on the modal footer
   *  so the user understands the cost shape. */
  totalTokens?: number;
}

export interface PersonaSpecCore {
  intellectualLineage: string[];
  loadBearingConcepts: string[];
  referentSet: string[];
  failureModes: string[];
  contrarianTakes: string[];
}

export interface PersonaKnowledge {
  /** What the loop learned, organised. The MD export renders these
   *  sections verbatim; the synthesizer pulls bits into the compiled
   *  instruction's "intellectual lineage" / "referent set" sections. */
  keyThinkers: PersonaKnowledgeEntry[];
  foundationalWorks: PersonaKnowledgeEntry[];
  recentDevelopments: PersonaKnowledgeEntry[];
  contestedClaims: PersonaKnowledgeEntry[];
  /** Audit trail · every search query the ReAct planner ran, with
   *  result counts. Useful for the user to see why a build was thin. */
  searchQueries: PersonaSearchRound[];
}

export interface PersonaKnowledgeEntry {
  title: string;
  summary: string;
  citations: string[]; // URLs surfaced in the search loop
}

export interface PersonaSearchRound {
  query: string;
  resultsCount: number;
  pagesRead: number;
}

export interface PersonaRule {
  kind: "always" | "never" | "conditional";
  rule: string;
}

export interface PersonaFewShot {
  scenario: string;
  genericResponse: string; // what a generic AI would say
  personaResponse: string; // what THIS persona says
  rationale: string;       // why they differ
}

export interface PersonaEvalEntry {
  prompt: string;
  expectedSignature: string;
  /** Embedding distance between persona vs generic-baseline response.
   *  Higher = more differentiated. Null when the eval failed for this
   *  prompt (e.g. embedding API unreachable). */
  divergenceScore: number | null;
}

export type AgentVoiceProvider = "openai" | "minimax" | "elevenlabs" | "azure" | "browser" | "custom";

export interface AgentVoiceProfile {
  provider: AgentVoiceProvider;
  model: string;
  voiceId: string;
  speed?: number;        // 0.5~2.0, default 1.0
  pitch?: number;        // -12~12, default 0
  volume?: number;       // 0~10, default 1.0
  emotion?: string;      // happy|sad|angry|fearful|disgusted|surprised|calm|fluent
  // voice_modify (advanced fine-tuning)
  modifyPitch?: number;     // -100~100, 低沉↔明亮
  modifyIntensity?: number; // -100~100, 刚劲↔轻柔
  modifyTimbre?: number;    // -100~100, 浑厚↔清脆
  instructions?: string;
}

interface Row {
  id: string;
  name: string;
  handle: string;
  role_tag: string;
  role_kind: string;
  bio: string;
  cover_quote: string | null;
  instruction: string;
  model_v: string;
  carrier_pref: string | null;
  avatar_path: string;
  ability_json: string | null;
  is_pinned: number;
  is_seed: number;
  web_search_enabled: number;
  voice_json: string | null;
  persona_spec_json: string | null;
  user_rules_json: string | null;
  avatar3d_json: string | null;
  model_by_provider_json: string | null;
  voice_by_provider_json: string | null;
  created_at: number;
  updated_at: number;
}

/** SIM-swap memory · the user's most-recent manual pick for this
 *  agent, indexed by LLM carrier. Lives ALONGSIDE the row's main
 *  `model_v` value, not in place of it. Whenever the user PATCHes
 *  modelV, the value is also stored here under the currently-active
 *  carrier. Whenever the active carrier changes, the reconcile pass
 *  snapshots the OLD `model_v` into this bucket under the prior
 *  carrier (so it survives the switch) and then restores the NEW
 *  carrier's bucketed value (if any) into `model_v`. Keys absent
 *  from the bucket mean "user never picked anything custom on that
 *  carrier" — the reconcile falls through to the default carrier
 *  primary / random fast-pool pick. */
export type ModelByProvider = Partial<Record<AgentCarrierPref, string>>;

/** SIM-swap memory · the user's most-recent voice profile for this
 *  agent, indexed by VOICE provider (credentialed only · "minimax" |
 *  "elevenlabs"). Mirror of `ModelByProvider` for the TTS side. Voice
 *  bucket entries are always reachable by construction (key === the
 *  profile's provider), so no reachability check on restore — only
 *  the snapshot-and-swap dance. Other provider profiles (browser /
 *  openai / azure / custom) flow through `PATCH` unchanged but
 *  intentionally do NOT seed the bucket — those are fallbacks, not
 *  SIM cards. */
export type VoiceByProvider = Partial<Record<VoiceProvider, AgentVoiceProfile>>;

function parseAbility(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

const VALID_VOICE_PROVIDERS: ReadonlySet<AgentVoiceProvider> = new Set([
  "openai", "minimax", "elevenlabs", "azure", "browser", "custom",
]);

function parseVoice(raw: string | null): AgentVoiceProfile | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const provider = typeof obj.provider === "string" && VALID_VOICE_PROVIDERS.has(obj.provider as AgentVoiceProvider)
      ? obj.provider as AgentVoiceProvider
      : null;
    const model = typeof obj.model === "string" ? obj.model.trim() : "";
    const voiceId = typeof obj.voiceId === "string" ? obj.voiceId.trim() : "";
    if (!provider || !model || !voiceId) return null;
    const out: AgentVoiceProfile = { provider, model, voiceId };
    if (typeof obj.speed === "number" && Number.isFinite(obj.speed)) out.speed = obj.speed;
    if (typeof obj.pitch === "number" && Number.isFinite(obj.pitch)) out.pitch = obj.pitch;
    if (typeof obj.volume === "number" && Number.isFinite(obj.volume)) out.volume = obj.volume;
    // Emotion + voice_modify fine-tuning fields. Previously dropped at
    // this read-back layer; without them the UI label always reverts
    // to "auto" after the page reloads even when emotion was set.
    if (typeof obj.emotion === "string" && obj.emotion.trim()) {
      out.emotion = obj.emotion.trim();
    }
    if (typeof obj.modifyPitch === "number" && Number.isFinite(obj.modifyPitch)) {
      out.modifyPitch = obj.modifyPitch;
    }
    if (typeof obj.modifyIntensity === "number" && Number.isFinite(obj.modifyIntensity)) {
      out.modifyIntensity = obj.modifyIntensity;
    }
    if (typeof obj.modifyTimbre === "number" && Number.isFinite(obj.modifyTimbre)) {
      out.modifyTimbre = obj.modifyTimbre;
    }
    if (typeof obj.instructions === "string" && obj.instructions.trim()) {
      out.instructions = obj.instructions.trim().slice(0, 500);
    }
    return out;
  } catch {
    return null;
  }
}

/** Defensive parser · the JSON blob can be old-shape (different
 *  PersonaSpec.version), partially populated by an aborted save, or
 *  hand-edited via direct DB access. Walk the fields one at a time
 *  and only keep what's well-formed; an unrecognised version returns
 *  null so callers fall back to "no persona" (treats the agent as
 *  Signal-mode) instead of crashing on a future schema. */
function parsePersonaSpec(raw: string | null): PersonaSpec | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    if (obj.version !== 1) return null; // schema bump · don't try to read forward
    const description = typeof obj.description === "string" ? obj.description : "";
    const generatedAt = typeof obj.generatedAt === "string" ? obj.generatedAt : new Date(0).toISOString();
    const stringArray = (v: unknown): string[] => Array.isArray(v) ? v.filter((x) => typeof x === "string") as string[] : [];
    const specRaw = (obj.spec as Record<string, unknown> | undefined) || {};
    const spec: PersonaSpecCore = {
      intellectualLineage: stringArray(specRaw.intellectualLineage),
      loadBearingConcepts: stringArray(specRaw.loadBearingConcepts),
      referentSet: stringArray(specRaw.referentSet),
      failureModes: stringArray(specRaw.failureModes),
      contrarianTakes: stringArray(specRaw.contrarianTakes),
    };
    const knowledgeRaw = (obj.knowledge as Record<string, unknown> | undefined) || {};
    const parseEntries = (v: unknown): PersonaKnowledgeEntry[] => {
      if (!Array.isArray(v)) return [];
      return v.flatMap((e) => {
        if (!e || typeof e !== "object") return [];
        const r = e as Record<string, unknown>;
        const title = typeof r.title === "string" ? r.title : "";
        const summary = typeof r.summary === "string" ? r.summary : "";
        if (!title && !summary) return [];
        return [{ title, summary, citations: stringArray(r.citations) }];
      });
    };
    const parseRounds = (v: unknown): PersonaSearchRound[] => {
      if (!Array.isArray(v)) return [];
      return v.flatMap((e) => {
        if (!e || typeof e !== "object") return [];
        const r = e as Record<string, unknown>;
        if (typeof r.query !== "string") return [];
        return [{
          query: r.query,
          resultsCount: typeof r.resultsCount === "number" ? r.resultsCount : 0,
          pagesRead: typeof r.pagesRead === "number" ? r.pagesRead : 0,
        }];
      });
    };
    const knowledge: PersonaKnowledge = {
      keyThinkers: parseEntries(knowledgeRaw.keyThinkers),
      foundationalWorks: parseEntries(knowledgeRaw.foundationalWorks),
      recentDevelopments: parseEntries(knowledgeRaw.recentDevelopments),
      contestedClaims: parseEntries(knowledgeRaw.contestedClaims),
      searchQueries: parseRounds(knowledgeRaw.searchQueries),
    };
    const rules: PersonaRule[] = Array.isArray(obj.rules)
      ? (obj.rules as unknown[]).flatMap((r) => {
          if (!r || typeof r !== "object") return [];
          const x = r as Record<string, unknown>;
          const kind = x.kind === "always" || x.kind === "never" || x.kind === "conditional" ? x.kind : null;
          if (!kind || typeof x.rule !== "string") return [];
          return [{ kind, rule: x.rule }];
        })
      : [];
    const fewShot: PersonaFewShot[] = Array.isArray(obj.fewShot)
      ? (obj.fewShot as unknown[]).flatMap((r) => {
          if (!r || typeof r !== "object") return [];
          const x = r as Record<string, unknown>;
          if (typeof x.scenario !== "string" || typeof x.personaResponse !== "string") return [];
          return [{
            scenario: x.scenario,
            genericResponse: typeof x.genericResponse === "string" ? x.genericResponse : "",
            personaResponse: x.personaResponse,
            rationale: typeof x.rationale === "string" ? x.rationale : "",
          }];
        })
      : [];
    const reflectionChecklist: string[] = stringArray(obj.reflectionChecklist);
    const evalSet: PersonaEvalEntry[] = Array.isArray(obj.evalSet)
      ? (obj.evalSet as unknown[]).flatMap((r) => {
          if (!r || typeof r !== "object") return [];
          const x = r as Record<string, unknown>;
          if (typeof x.prompt !== "string") return [];
          return [{
            prompt: x.prompt,
            expectedSignature: typeof x.expectedSignature === "string" ? x.expectedSignature : "",
            divergenceScore: typeof x.divergenceScore === "number" && Number.isFinite(x.divergenceScore)
              ? x.divergenceScore
              : null,
          }];
        })
      : [];
    const differentiationScore = typeof obj.differentiationScore === "number" && Number.isFinite(obj.differentiationScore)
      ? obj.differentiationScore
      : null;
    const toolAccessRaw = (obj.toolAccess as Record<string, unknown> | undefined) || {};
    const toolAccess = { webSearch: toolAccessRaw.webSearch !== false };
    const buildLog = parseBuildLog(obj.buildLog);
    const guessName = typeof obj.guessName === "string" && obj.guessName.trim().length > 0
      ? obj.guessName.trim()
      : undefined;
    return {
      version: 1,
      generatedAt,
      description,
      spec,
      knowledge,
      rules,
      fewShot,
      reflectionChecklist,
      evalSet,
      differentiationScore,
      toolAccess,
      ...(guessName ? { guessName } : {}),
      ...(buildLog ? { buildLog } : {}),
    };
  } catch {
    return null;
  }
}

/** Defensive parser for the buildLog blob. Unknown event kinds are
 *  dropped (forward-compat with future BuildEvent additions); a missing
 *  or malformed blob returns null so the agent profile UI hides the
 *  build-log entry point. */
function parseBuildLog(raw: unknown): PersonaBuildLog | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const narrative = typeof obj.narrative === "string" ? obj.narrative : "";
  const locale = obj.locale === "en" || obj.locale === "zh" || obj.locale === "ja" || obj.locale === "es"
    ? obj.locale
    : "en";
  const generatedAt = typeof obj.generatedAt === "number" && Number.isFinite(obj.generatedAt)
    ? obj.generatedAt
    : 0;
  const events: BuildEvent[] = [];
  if (Array.isArray(obj.events)) {
    for (const e of obj.events as unknown[]) {
      if (!e || typeof e !== "object") continue;
      const ev = e as Record<string, unknown>;
      const ts = typeof ev.ts === "number" ? ev.ts : 0;
      const kind = ev.kind;
      if (kind === "phase-start" && typeof ev.phase === "number" && typeof ev.label === "string") {
        events.push({ kind, ts, phase: ev.phase, label: ev.label });
      } else if (kind === "phase-end" && typeof ev.phase === "number" && typeof ev.durationMs === "number") {
        events.push({ kind, ts, phase: ev.phase, durationMs: ev.durationMs });
      } else if (kind === "dimension-plan" && Array.isArray(ev.dimensions)) {
        const dims = (ev.dimensions as unknown[]).flatMap((d) => {
          if (!d || typeof d !== "object") return [];
          const x = d as Record<string, unknown>;
          if (typeof x.dimension !== "string" || typeof x.query !== "string") return [];
          return [{
            dimension: x.dimension,
            query: x.query,
            why: typeof x.why === "string" ? x.why : "",
          }];
        });
        events.push({ kind, ts, dimensions: dims });
      } else if (kind === "search" && typeof ev.query === "string") {
        events.push({
          kind,
          ts,
          query: ev.query,
          resultsCount: typeof ev.resultsCount === "number" ? ev.resultsCount : 0,
          pagesRead: typeof ev.pagesRead === "number" ? ev.pagesRead : 0,
          ...(typeof ev.dimension === "string" ? { dimension: ev.dimension } : {}),
          ...(typeof ev.round === "number" ? { round: ev.round } : {}),
          ...(ev.topup === true ? { topup: true } : {}),
        });
      } else if (kind === "divergence") {
        events.push({
          kind,
          ts,
          score: typeof ev.score === "number" && Number.isFinite(ev.score) ? ev.score : null,
        });
      } else if (kind === "error" && typeof ev.message === "string") {
        events.push({ kind, ts, message: ev.message });
      }
    }
  }
  if (!narrative && events.length === 0) return null;
  const totalTokens = typeof obj.totalTokens === "number" && Number.isFinite(obj.totalTokens)
    ? Math.max(0, Math.round(obj.totalTokens))
    : undefined;
  return {
    narrative,
    locale,
    generatedAt,
    events,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/** SIM-swap bucket parser · drops any key not in VALID_CARRIER_PREFS
 *  and any value not a string. Returns an empty object (not null) so
 *  callers can index without a guard. */
function parseModelByProvider(raw: string | null): ModelByProvider {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: ModelByProvider = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (VALID_CARRIER_PREFS.has(k as AgentCarrierPref)
          && typeof v === "string"
          && v.trim().length > 0) {
        out[k as AgentCarrierPref] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** SIM-swap voice-bucket parser · same shape contract as the model
 *  bucket. Only `"minimax"` / `"elevenlabs"` keys are kept; each
 *  value runs through `parseVoice` (by re-stringifying) so malformed
 *  profiles drop silently · the bucket can NEVER produce a profile
 *  the rest of the codebase can't synth against. */
function parseVoiceByProvider(raw: string | null): VoiceByProvider {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: VoiceByProvider = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k !== "minimax" && k !== "elevenlabs") continue;
      // Compose parseVoice for consistency · profile fields normalise
      // identically to the main `voice_json` blob. parseVoice expects
      // a string, so we re-stringify the sub-object first.
      const profile = parseVoice(JSON.stringify(v));
      if (profile) out[k as VoiceProvider] = profile;
    }
    return out;
  } catch {
    return {};
  }
}

function serializeModelByProvider(b: ModelByProvider): string | null {
  if (!b || Object.keys(b).length === 0) return null;
  return JSON.stringify(b);
}

function serializeVoiceByProvider(b: VoiceByProvider): string | null {
  if (!b || Object.keys(b).length === 0) return null;
  // Each value goes through serializeVoice so the on-disk shape is
  // identical to the main voice_json blob's normalised form. Strip
  // entries that fail serialisation (defensive · should never happen
  // because parse rejects them, but cheap).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (!v) continue;
    const json = serializeVoice(v);
    if (!json) continue;
    out[k] = JSON.parse(json);
  }
  if (Object.keys(out).length === 0) return null;
  return JSON.stringify(out);
}

function serializeVoice(v: AgentVoiceProfile | null): string | null {
  if (!v) return null;
  const provider = VALID_VOICE_PROVIDERS.has(v.provider) ? v.provider : null;
  const model = typeof v.model === "string" ? v.model.trim() : "";
  const voiceId = typeof v.voiceId === "string" ? v.voiceId.trim() : "";
  if (!provider || !model || !voiceId) return null;
  return JSON.stringify({
    provider,
    model,
    voiceId,
    ...(typeof v.speed === "number" && Number.isFinite(v.speed) ? { speed: Math.max(0.5, Math.min(2, v.speed)) } : {}),
    ...(typeof v.pitch === "number" && Number.isFinite(v.pitch) ? { pitch: Math.max(-12, Math.min(12, v.pitch)) } : {}),
    ...(typeof v.volume === "number" && Number.isFinite(v.volume) ? { volume: Math.max(0, Math.min(2, v.volume)) } : {}),
    // Emotion + voice_modify fine-tuning fields. Without these the
    // route layer accepts the patch but the storage layer silently
    // drops them, so settings disappear on the next page load.
    ...(typeof v.emotion === "string" && v.emotion.trim() ? { emotion: v.emotion.trim() } : {}),
    ...(typeof v.modifyPitch === "number" && Number.isFinite(v.modifyPitch)
      ? { modifyPitch: Math.max(-100, Math.min(100, v.modifyPitch)) } : {}),
    ...(typeof v.modifyIntensity === "number" && Number.isFinite(v.modifyIntensity)
      ? { modifyIntensity: Math.max(-100, Math.min(100, v.modifyIntensity)) } : {}),
    ...(typeof v.modifyTimbre === "number" && Number.isFinite(v.modifyTimbre)
      ? { modifyTimbre: Math.max(-100, Math.min(100, v.modifyTimbre)) } : {}),
    ...(v.instructions && v.instructions.trim() ? { instructions: v.instructions.trim().slice(0, 500) } : {}),
  });
}

function mapRow(row: Row): Agent {
  const kind: AgentRoleKind = row.role_kind === "moderator" ? "moderator" : "director";
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    roleTag: row.role_tag,
    roleKind: kind,
    bio: row.bio,
    coverQuote: row.cover_quote,
    instruction: row.instruction,
    modelV: row.model_v,
    carrierPref: parseCarrierPref(row.carrier_pref),
    avatarPath: row.avatar_path,
    ability: parseAbility(row.ability_json),
    isPinned: row.is_pinned === 1,
    isSeed: row.is_seed === 1,
    webSearchEnabled: row.web_search_enabled !== 0,
    voice: parseVoice(row.voice_json),
    personaSpec: parsePersonaSpec(row.persona_spec_json),
    userRules: parseUserRules(row.user_rules_json),
    avatar3d: parseAvatar3d(row.avatar3d_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const HEX6_RE = /^#[0-9a-f]{6}$/i;

/** Parse the persisted 3D-avatar config. Returns `null` on null / malformed
 *  blobs or any field-shape mismatch (the four id fields must be strings, the
 *  four colour fields must be `#rrggbb`). A clean null lets the room fall back
 *  to its deterministic per-id default rather than build from a partial. */
export function parseAvatar3d(json: string | null | undefined): Avatar3dConfig | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json);
    if (!o || typeof o !== "object") return null;
    // Required identity / palette fields. Top + bottom and the legacy
    // outfit are validated below as a unit: a config is valid as long as
    // it carries EITHER the new split (top + bottom) OR the legacy
    // outfitStyle/outfit pair.
    const ids = ["model", "hairStyle", "accessory"] as const;
    const cols = ["skin", "hair", "brow"] as const;
    for (const k of ids) if (typeof o[k] !== "string" || !o[k]) return null;
    for (const k of cols) if (typeof o[k] !== "string" || !HEX6_RE.test(o[k])) return null;
    const hasSplit = typeof o.topStyle === "string" && typeof o.bottomStyle === "string"
                    && typeof o.top === "string" && HEX6_RE.test(o.top)
                    && typeof o.bottom === "string" && HEX6_RE.test(o.bottom);
    const hasLegacy = typeof o.outfitStyle === "string" && o.outfitStyle
                    && typeof o.outfit === "string" && HEX6_RE.test(o.outfit);
    if (!hasSplit && !hasLegacy) return null;
    const cfg: Avatar3dConfig = {
      model: o.model, hairStyle: o.hairStyle, accessory: o.accessory,
      skin: o.skin, hair: o.hair, brow: o.brow,
    };
    if (hasSplit) {
      cfg.topStyle = o.topStyle; cfg.bottomStyle = o.bottomStyle;
      cfg.top = o.top; cfg.bottom = o.bottom;
    }
    if (hasLegacy) { cfg.outfitStyle = o.outfitStyle; cfg.outfit = o.outfit; }
    // Optional newer dimensions · kept only when present + valid (back-compat).
    if (typeof o.browStyle === "string" && o.browStyle) cfg.browStyle = o.browStyle;
    if (typeof o.eyeStyle === "string" && o.eyeStyle) cfg.eyeStyle = o.eyeStyle;
    if (typeof o.tieStyle === "string" && o.tieStyle) cfg.tieStyle = o.tieStyle;
    if (typeof o.beardStyle === "string" && o.beardStyle) cfg.beardStyle = o.beardStyle;
    if (typeof o.beard === "string" && HEX6_RE.test(o.beard)) cfg.beard = o.beard;
    if (typeof o.tie === "string" && HEX6_RE.test(o.tie)) cfg.tie = o.tie;
    if (typeof o.eye === "string" && HEX6_RE.test(o.eye)) cfg.eye = o.eye;
    return cfg;
  } catch {
    return null;
  }
}

/** Parse the persisted user-rules JSON array. Tolerates null / malformed
 *  blobs (returns []) and drops non-string / empty entries so the prompt
 *  builder always gets a clean string[]. Capped to keep a runaway list
 *  from bloating every director turn. */
export function parseUserRules(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
      .slice(0, 12);
  } catch {
    return [];
  }
}

const SELECT_COLS =
  "id, name, handle, role_tag, role_kind, bio, cover_quote, instruction, model_v, carrier_pref, " +
  "avatar_path, ability_json, is_pinned, is_seed, web_search_enabled, voice_json, " +
  "persona_spec_json, user_rules_json, avatar3d_json, model_by_provider_json, voice_by_provider_json, created_at, updated_at";

/** Directors only — the moderator (chair) is hidden from generic listings. */
export function listAgents(): Agent[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM agents
       WHERE role_kind = 'director'
       ORDER BY is_pinned DESC, created_at ASC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** All agents including the chair — used by orchestrator + room state. */
export function listAllAgents(): Agent[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents ORDER BY is_pinned DESC, created_at ASC`)
    .all() as Row[];
  return rows.map(mapRow);
}

/** The single chair agent. There's only ever one moderator in v1. */
export function getChairAgent(): Agent | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents WHERE role_kind = 'moderator' LIMIT 1`)
    .get() as Row | undefined;
  return row ? mapRow(row) : null;
}

export function countAgents(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number };
  return row.n;
}

export interface AgentStats {
  /** Distinct rooms the agent has been a member of (chair seat at
   *  position -1 excluded). */
  roomsJoined: number;
  /** Distinct (room_id, round_num) pairs the agent has spoken in.
   *  Counts a round only if the agent actually produced a message —
   *  silent presence doesn't bump the counter. */
  roundsSpoken: number;
  /** Cumulative tokens billed against this agent across every LLM
   *  turn — written by the orchestrator after each callLLMStream
   *  finishes via incrementAgentTokens. */
  tokensConsumed: number;
}

/** Returns the three counters surfaced on the agent profile. Cheap
 *  enough to compute on every profile open (small tables, indexed
 *  columns); skip a stats table until volumes warrant it. */
export function getAgentStats(agentId: string): AgentStats {
  const db = getDb();
  const rooms = db
    .prepare(
      "SELECT COUNT(*) AS n FROM room_members WHERE agent_id = ? AND position >= 0",
    )
    .get(agentId) as { n: number } | undefined;
  const rounds = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT room_id, round_num FROM messages
         WHERE author_id = ? AND author_kind = 'agent'
       )`,
    )
    .get(agentId) as { n: number } | undefined;
  const tokens = db
    .prepare("SELECT tokens_consumed AS n FROM agents WHERE id = ?")
    .get(agentId) as { n: number } | undefined;
  return {
    roomsJoined: rooms?.n ?? 0,
    roundsSpoken: rounds?.n ?? 0,
    tokensConsumed: tokens?.n ?? 0,
  };
}

/** Bump an agent's cumulative token counter by `delta`. Negative or
 *  zero deltas are no-ops. Called from the orchestrator after each
 *  director / chair stream finishes with the SDK's reported usage.
 *
 *  Writes go to TWO tables atomically (single transaction):
 *    · `agents.tokens_consumed` · canonical lifetime/cumulative total.
 *    · `usage_daily(day, agent_id, model_v)` · per-day-per-model log
 *      that drives the 14-day stacked bar chart in the Usage panel.
 *
 *  `model_v` is snapshotted from the agent row at billing time. If the
 *  user later reassigns the agent to a different model, that day's
 *  history stays tied to the model that actually ran — the chart
 *  doesn't silently re-skin historical bars.
 *
 *  `day` is server-local-time `YYYY-MM-DD`. This is local-first software
 *  running on the user's own machine, so wall-clock time matches their
 *  intuition of "today" without timezone gymnastics on the client. */
export function incrementAgentTokens(agentId: string, delta: number): void {
  if (!Number.isFinite(delta) || delta <= 0) return;
  const tokens = Math.round(delta);
  const day = formatLocalDay(new Date());
  const db = getDb();
  const tx = db.transaction(() => {
    // Snapshot model_v from the row we're billing so a later model
    // reassignment doesn't retroactively rewrite the day-bucket.
    const agentRow = db
      .prepare("SELECT model_v FROM agents WHERE id = ?")
      .get(agentId) as { model_v: string } | undefined;
    if (!agentRow) return; // agent was deleted between turn-finish and bill-write
    db.prepare("UPDATE agents SET tokens_consumed = tokens_consumed + ? WHERE id = ?")
      .run(tokens, agentId);
    db.prepare(
      `INSERT INTO usage_daily (day, agent_id, model_v, tokens) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, agent_id, model_v) DO UPDATE SET tokens = tokens + excluded.tokens`,
    ).run(day, agentId, agentRow.model_v, tokens);
  });
  tx();
}

/** Format a Date as `YYYY-MM-DD` in the server's local timezone. */
function formatLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Cumulative usage summary used by the Usage panel in user-settings.
 *  Aggregates the per-agent token counter into total / by-model / by-agent
 *  rollups in a single pass. Cheap (small tables, indexed on agents.id). */
export interface UsageAgentRow {
  id: string;
  name: string;
  handle: string;
  modelV: string;
  roleKind: AgentRoleKind;
  tokens: number;
}
export interface UsageModelRow {
  modelV: string;
  tokens: number;
  agents: number;
}
/** Aggregate of tokens that belonged to since-deleted agents. Per-agent
 *  identity is gone but the model-level rollup survives so the Usage
 *  panel total stays accurate. */
export interface UsageRetired {
  /** Total tokens billed to retired agents across all models. */
  tokens: number;
  /** Distinct retired agents folded in (sum across all models). */
  agents: number;
  /** Per-model breakdown of the retired bucket. Each entry already
   *  flows into the matching `byModel` row in the summary; this exists
   *  for callers that want to surface retired-only data separately. */
  byModel: UsageModelRow[];
}

/** One day's usage rollup · the per-bar payload for the 14-day chart
 *  AND the per-day drill-down in the Usage panel. The shape mirrors the
 *  cumulative `UsageSummary.byModel` / `byAgent` so the frontend can
 *  feed the same render component either source. `day` is the
 *  server-local `YYYY-MM-DD` the row's tokens were billed on. */
export interface UsageDayRow {
  day: string;
  totalTokens: number;
  byModel: UsageModelRow[];
  byAgent: UsageAgentRow[];
}

export interface UsageSummary {
  totalTokens: number;
  agentCount: number;
  byModel: UsageModelRow[];
  byAgent: UsageAgentRow[];
  retired: UsageRetired;
  /** Rolling 14-day window, oldest → newest, server-local time.
   *  Always 14 entries · zero-token days fill in as `totalTokens: 0`
   *  with empty `byModel` / `byAgent` arrays so the chart renders a
   *  stable axis instead of a sparse one. */
  daily: UsageDayRow[];
}

export function getUsageSummary(): UsageSummary {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, handle, model_v, role_kind, tokens_consumed
         FROM agents
       ORDER BY tokens_consumed DESC, created_at ASC`,
    )
    .all() as Array<{
      id: string;
      name: string;
      handle: string;
      model_v: string;
      role_kind: string;
      tokens_consumed: number;
    }>;

  let liveTokens = 0;
  // Track live vs. retired separately so the per-model row can split
  // them when surfacing rollups.
  const modelLive = new Map<string, { tokens: number; agents: number }>();
  const byAgent: UsageAgentRow[] = [];

  for (const r of rows) {
    const tokens = r.tokens_consumed || 0;
    liveTokens += tokens;
    const cur = modelLive.get(r.model_v) ?? { tokens: 0, agents: 0 };
    cur.tokens += tokens;
    cur.agents += 1;
    modelLive.set(r.model_v, cur);
    byAgent.push({
      id: r.id,
      name: r.name,
      handle: r.handle,
      modelV: r.model_v,
      roleKind: r.role_kind === "moderator" ? "moderator" : "director",
      tokens,
    });
  }

  // Pull the retired rollup. `agents` here is the count of distinct
  // deleted agents — they never fold back into byAgent (their identity
  // is gone), only their tokens do, via byModel.
  const retiredRows = db
    .prepare("SELECT model_v AS modelV, tokens, agents FROM retired_token_usage")
    .all() as Array<{ modelV: string; tokens: number; agents: number }>;
  const retiredByModel: UsageModelRow[] = [];
  let retiredTokens = 0;
  let retiredAgents = 0;
  for (const r of retiredRows) {
    if (!r.tokens) continue;
    retiredTokens += r.tokens;
    retiredAgents += r.agents;
    retiredByModel.push({ modelV: r.modelV, tokens: r.tokens, agents: r.agents });
  }

  // Merge live + retired by model so the panel's per-model rollup
  // reflects everything ever billed against the user's wallet.
  const merged = new Map<string, { tokens: number; agents: number }>();
  for (const [m, v] of modelLive) merged.set(m, { ...v });
  for (const r of retiredByModel) {
    const cur = merged.get(r.modelV) ?? { tokens: 0, agents: 0 };
    cur.tokens += r.tokens;
    cur.agents += r.agents;
    merged.set(r.modelV, cur);
  }
  const byModel: UsageModelRow[] = Array.from(merged.entries())
    .map(([modelV, v]) => ({ modelV, tokens: v.tokens, agents: v.agents }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totalTokens: liveTokens + retiredTokens,
    agentCount: rows.length,
    byModel,
    byAgent,
    retired: {
      tokens: retiredTokens,
      agents: retiredAgents,
      byModel: retiredByModel.sort((a, b) => b.tokens - a.tokens),
    },
    daily: getDailyUsage(14),
  };
}

/** Rolling N-day window from `usage_daily`, joined back to `agents` for
 *  per-agent display fields (name, handle, role) and pre-aggregated
 *  into per-model + per-agent rollups per day. Always returns N entries
 *  oldest → newest; zero-token days are zero-filled so the bar chart
 *  has a stable axis even on installs with sparse usage. Pre-migration
 *  history is irrecoverable (no backfill), so an install older than
 *  the migration just shows the last few days populated and earlier
 *  bars at zero. */
export function getDailyUsage(days: number): UsageDayRow[] {
  const today = new Date();
  // Build the 14-day window keyed by `YYYY-MM-DD` and seeded with
  // empty rollups so days with no usage still appear as bars at
  // the baseline.
  const out: UsageDayRow[] = [];
  const dayIndex = new Map<string, UsageDayRow>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = formatLocalDay(d);
    const row: UsageDayRow = { day: key, totalTokens: 0, byModel: [], byAgent: [] };
    out.push(row);
    dayIndex.set(key, row);
  }
  if (out.length === 0) return out;

  const earliest = out[0].day;
  // Pull every (day, agent_id, model_v) row inside the window plus the
  // per-agent display fields. LEFT JOIN survives agents that have been
  // deleted (their rows here would be orphaned by the upcoming retired-
  // tokens flow, but until that hard-deletes the daily rows we keep
  // them visible under their original name).
  const rows = getDb()
    .prepare(
      `SELECT u.day      AS day,
              u.agent_id AS agentId,
              u.model_v  AS modelV,
              u.tokens   AS tokens,
              a.name     AS name,
              a.handle   AS handle,
              a.role_kind AS roleKind
         FROM usage_daily u
         LEFT JOIN agents a ON a.id = u.agent_id
        WHERE u.day >= ?
        ORDER BY u.day ASC`,
    )
    .all(earliest) as Array<{
      day: string;
      agentId: string;
      modelV: string;
      tokens: number;
      name: string | null;
      handle: string | null;
      roleKind: string | null;
    }>;

  // Per-day aggregation buckets · model rollups need (tokens, distinct-
  // agent count); agent rollups need full identity + tokens summed
  // across the day's models for that agent.
  const modelBuckets = new Map<string, Map<string, { tokens: number; agents: Set<string> }>>();
  const agentBuckets = new Map<string, Map<string, UsageAgentRow>>();

  for (const r of rows) {
    if (!dayIndex.has(r.day)) continue; // outside window (defensive)
    let mb = modelBuckets.get(r.day);
    if (!mb) { mb = new Map(); modelBuckets.set(r.day, mb); }
    const mEntry = mb.get(r.modelV) ?? { tokens: 0, agents: new Set<string>() };
    mEntry.tokens += r.tokens;
    mEntry.agents.add(r.agentId);
    mb.set(r.modelV, mEntry);

    let ab = agentBuckets.get(r.day);
    if (!ab) { ab = new Map(); agentBuckets.set(r.day, ab); }
    const aEntry = ab.get(r.agentId) ?? {
      id: r.agentId,
      name: r.name ?? "(retired)",
      handle: r.handle ?? "",
      modelV: r.modelV, // the day-prevalent model snapshot
      roleKind: r.roleKind === "moderator" ? "moderator" : "director",
      tokens: 0,
    };
    aEntry.tokens += r.tokens;
    ab.set(r.agentId, aEntry);
  }

  // Project the buckets back into the seeded window order.
  for (const day of out) {
    const mb = modelBuckets.get(day.day);
    if (mb) {
      day.byModel = Array.from(mb.entries())
        .map(([modelV, v]) => ({ modelV, tokens: v.tokens, agents: v.agents.size }))
        .sort((a, b) => b.tokens - a.tokens);
      day.totalTokens = day.byModel.reduce((s, m) => s + m.tokens, 0);
    }
    const ab = agentBuckets.get(day.day);
    if (ab) {
      day.byAgent = Array.from(ab.values()).sort((a, b) => b.tokens - a.tokens);
    }
  }

  return out;
}

export function getAgent(id: string): Agent | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function getAgentByHandle(handle: string): Agent | null {
  const db = getDb();
  const stmt = db.prepare(`SELECT ${SELECT_COLS} FROM agents WHERE handle = ?`);
  for (const candidate of agentHandleLookupCandidates(handle)) {
    const row = stmt.get(candidate) as Row | undefined;
    if (row) return mapRow(row);
  }
  return null;
}

export interface AgentInsert {
  id: string;
  name: string;
  handle: string;
  roleTag: string;
  roleKind?: AgentRoleKind;
  bio: string;
  coverQuote?: string | null;
  instruction: string;
  modelV: string;
  /** Optional carrier override at insert time. Most seed paths leave
   *  this null and let the adapter route by default precedence. */
  carrierPref?: AgentCarrierPref | null;
  avatarPath: string;
  ability?: Record<string, number> | null;
  voice?: AgentVoiceProfile | null;
  isPinned?: boolean;
  isSeed?: boolean;
  /** Set when the agent was built via the Full-persona pipeline.
   *  Stored as JSON in `persona_spec_json` and unlocks runtime
   *  injection of few-shot examples + reflection checklist into the
   *  per-turn director system prompt. */
  personaSpec?: PersonaSpec | null;
  /** Seed-supplied 3D-avatar config (chair + core directors get a
   *  hand-picked "捏 avatar" default so the voice room + marketing
   *  page render the canonical look out of the box). NULL on every
   *  user-generated insert; users build their own via the editor. */
  avatar3d?: Avatar3dConfig | null;
}

export function insertAgent(a: AgentInsert): Agent {
  const now = Date.now();
  const abilityJson = a.ability && Object.keys(a.ability).length > 0
    ? JSON.stringify(a.ability)
    : null;
  // Web Search defaults OFF for new agents. Schema-level default
  // stays at 1 (changing it requires a SQLite full table rebuild),
  // so we explicitly write 0 here. Users opt in via the toggle on
  // the agent profile after configuring the global Brave key.
  // Persona spec · serialised inline if the caller is creating a
  // Full-mode agent. NULL on every Signal-mode insert (current
  // /api/agents POST path) and on every seeded director.
  const personaSpecJson = a.personaSpec ? JSON.stringify(a.personaSpec) : null;
  // Full-mode agents born from a deep persona build default
  // web-search ON when the persona spec recommends it (the Phase 6
  // tool-access output). Signal-mode and seed inserts keep the
  // historical "opt-in via toggle" behaviour at 0.
  const initialWebSearch = a.personaSpec?.toolAccess?.webSearch ? 1 : 0;
  const avatar3dJson = a.avatar3d ? JSON.stringify(a.avatar3d) : null;
  getDb()
    .prepare(
      `INSERT INTO agents
       (id, name, handle, role_tag, role_kind, bio, cover_quote, instruction, model_v, carrier_pref,
        avatar_path, ability_json, is_pinned, is_seed, web_search_enabled, voice_json,
        persona_spec_json, avatar3d_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.id,
      a.name,
      a.handle,
      a.roleTag,
      a.roleKind ?? "director",
      a.bio,
      a.coverQuote ?? null,
      a.instruction,
      a.modelV,
      a.carrierPref ?? null,
      a.avatarPath,
      abilityJson,
      a.isPinned ? 1 : 0,
      a.isSeed ? 1 : 0,
      initialWebSearch,
      serializeVoice(a.voice ?? null),
      personaSpecJson,
      avatar3dJson,
      now,
      now,
    );
  return getAgent(a.id)!;
}

/** Permanently delete an agent. room_members / skills / memories all
 *  cascade via FK ON DELETE CASCADE. Messages keep their author_id
 *  but resolve to "unknown agent" on the frontend (acceptable — we
 *  preserve the transcript history rather than cascading-delete every
 *  past utterance the agent ever spoke). Returns true on a real delete. */
/** Delete a custom agent. Before the row is removed, any
 *  `tokens_consumed` it has accumulated is transferred to
 *  `retired_token_usage`, keyed by model. This keeps the Usage panel's
 *  grand total + per-model rollup honest after deletions — the bytes
 *  the user already paid for don't silently vanish from the dashboard.
 *
 *  Per-agent identity is intentionally lost (deletion means "make it
 *  go away"); only the aggregate by model survives. */
export function deleteAgent(id: string): boolean {
  const db = getDb();
  const tx = db.transaction((agentId: string) => {
    const row = db
      .prepare(
        "SELECT model_v AS modelV, tokens_consumed AS tokens FROM agents WHERE id = ?",
      )
      .get(agentId) as { modelV: string; tokens: number } | undefined;
    if (row && row.tokens > 0 && row.modelV) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO retired_token_usage (model_v, tokens, agents, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(model_v) DO UPDATE SET
           tokens     = tokens + excluded.tokens,
           agents     = agents + 1,
           updated_at = excluded.updated_at`,
      ).run(row.modelV, row.tokens, now);
    }
    return db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes;
  });
  return tx(id) > 0;
}

/** Patch a subset of fields on an existing agent. Returns the row
 *  after the update, or null if no row matched. */
export function updateAgent(
  id: string,
  patch: {
    avatarPath?: string;
    modelV?: string;
    /** Pass `null` to clear the override, an `AgentCarrierPref` to
     *  set it, or omit the key to leave the field untouched. */
    carrierPref?: AgentCarrierPref | null;
    bio?: string;
    instruction?: string;
    webSearchEnabled?: boolean;
    ability?: Record<string, number> | null;
    voice?: AgentVoiceProfile | null;
    /** Toggle the sidebar's pin status for this director. Pinned
     *  agents float to the top "Pinned" bucket above Custom and Core
     *  in `renderSidebarAgents`. Surface-level UX only — no
     *  orchestrator behaviour depends on this flag. */
    isPinned?: boolean;
    /** Persona spec patch · pass `null` to clear (downgrades the
     *  agent to Signal-mode), or a `PersonaSpec` to write. Omitting
     *  the key leaves the column untouched. */
    personaSpec?: PersonaSpec | null;
    /** User-authored hard rules (agent profile). Pass an array to
     *  replace the full set (entries trimmed / empties dropped / capped),
     *  or omit the key to leave them untouched. An empty array clears. */
    userRules?: string[];
    /** 3D-avatar config (捏 avatar editor). Pass a config to save, `null`
     *  to clear, or omit the key to leave it untouched. */
    avatar3d?: Avatar3dConfig | null;
  },
): Agent | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.avatarPath === "string") {
    fields.push("avatar_path = ?");
    values.push(patch.avatarPath);
  }
  if (typeof patch.modelV === "string") {
    fields.push("model_v = ?");
    values.push(patch.modelV);
  }
  if (patch.carrierPref !== undefined) {
    fields.push("carrier_pref = ?");
    values.push(patch.carrierPref ?? null);
  }
  if (typeof patch.bio === "string") {
    fields.push("bio = ?");
    values.push(patch.bio);
  }
  if (typeof patch.instruction === "string") {
    fields.push("instruction = ?");
    values.push(patch.instruction);
  }
  if (typeof patch.webSearchEnabled === "boolean") {
    fields.push("web_search_enabled = ?");
    values.push(patch.webSearchEnabled ? 1 : 0);
  }
  if (patch.ability !== undefined) {
    fields.push("ability_json = ?");
    const json = patch.ability && Object.keys(patch.ability).length > 0
      ? JSON.stringify(patch.ability)
      : null;
    values.push(json);
  }
  if (patch.voice !== undefined) {
    fields.push("voice_json = ?");
    values.push(serializeVoice(patch.voice));
  }
  if (typeof patch.isPinned === "boolean") {
    fields.push("is_pinned = ?");
    values.push(patch.isPinned ? 1 : 0);
  }
  if (patch.personaSpec !== undefined) {
    fields.push("persona_spec_json = ?");
    values.push(patch.personaSpec ? JSON.stringify(patch.personaSpec) : null);
  }
  if (patch.userRules !== undefined) {
    fields.push("user_rules_json = ?");
    const clean = Array.isArray(patch.userRules)
      ? patch.userRules
          .filter((r): r is string => typeof r === "string")
          .map((r) => r.trim())
          .filter((r) => r.length > 0)
          .slice(0, 12)
      : [];
    values.push(clean.length > 0 ? JSON.stringify(clean) : null);
  }
  if (patch.avatar3d !== undefined) {
    fields.push("avatar3d_json = ?");
    values.push(patch.avatar3d ? JSON.stringify(patch.avatar3d) : null);
  }
  if (fields.length === 0) return getAgent(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  const r = getDb()
    .prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  if (r.changes === 0) return null;
  return getAgent(id);
}

/* ── SIM-swap memory · per-provider bucket CRUD ────────────────────
   These helpers are the ONLY way the bucket is touched. We intentionally
   do not extend `updateAgent` to accept bucket patches · bucket writes
   are owned by two specific callers:

     1. `reconcileAgentModels` / `reconcileAgentVoices` · snapshot the
        prior provider's value before overwriting `model_v` /
        `voice_json`, then seed the new provider's bucket entry after
        choosing a target.
     2. `PATCH /api/agents/:id` · whenever the user manually picks a
        model or voice, mirror the pick into the bucket under the
        currently-active LLM carrier (for modelV) or the voice's own
        provider (for voice).

   No downstream caller needs to know the bucket exists. Each helper
   reads its column, parses, mutates, and writes back atomically. The
   `updated_at` bump lets the front-end's last-write-wins refresh
   detect changes if it ever surfaces buckets in the UI (today: never). */

export function getModelBucket(id: string): ModelByProvider {
  const row = getDb()
    .prepare("SELECT model_by_provider_json FROM agents WHERE id = ?")
    .get(id) as { model_by_provider_json: string | null } | undefined;
  if (!row) return {};
  return parseModelByProvider(row.model_by_provider_json);
}

export function getVoiceBucket(id: string): VoiceByProvider {
  const row = getDb()
    .prepare("SELECT voice_by_provider_json FROM agents WHERE id = ?")
    .get(id) as { voice_by_provider_json: string | null } | undefined;
  if (!row) return {};
  return parseVoiceByProvider(row.voice_by_provider_json);
}

export function writeModelBucketEntry(
  id: string,
  carrier: AgentCarrierPref,
  modelV: string,
): void {
  if (!modelV) return;
  const bucket = getModelBucket(id);
  if (bucket[carrier] === modelV) return; // idempotent · skip self-write
  bucket[carrier] = modelV;
  const serialized = serializeModelByProvider(bucket);
  getDb()
    .prepare("UPDATE agents SET model_by_provider_json = ?, updated_at = ? WHERE id = ?")
    .run(serialized, Date.now(), id);
}

export function writeVoiceBucketEntry(
  id: string,
  provider: VoiceProvider,
  voice: AgentVoiceProfile,
): void {
  // Re-parse through the serializer round-trip so the on-disk shape
  // is normalised identically to the main voice_json blob. Drops
  // anything malformed silently.
  const normalized = parseVoice(serializeVoice(voice));
  if (!normalized || (normalized.provider !== "minimax" && normalized.provider !== "elevenlabs")) return;
  if (normalized.provider !== provider) return;
  const bucket = getVoiceBucket(id);
  bucket[provider] = normalized;
  const serialized = serializeVoiceByProvider(bucket);
  getDb()
    .prepare("UPDATE agents SET voice_by_provider_json = ?, updated_at = ? WHERE id = ?")
    .run(serialized, Date.now(), id);
}

export function deleteModelBucketEntry(
  id: string,
  carrier: AgentCarrierPref,
): void {
  const bucket = getModelBucket(id);
  if (!(carrier in bucket)) return;
  delete bucket[carrier];
  const serialized = serializeModelByProvider(bucket);
  getDb()
    .prepare("UPDATE agents SET model_by_provider_json = ?, updated_at = ? WHERE id = ?")
    .run(serialized, Date.now(), id);
}

export function deleteVoiceBucketEntry(
  id: string,
  provider: VoiceProvider,
): void {
  const bucket = getVoiceBucket(id);
  if (!(provider in bucket)) return;
  delete bucket[provider];
  const serialized = serializeVoiceByProvider(bucket);
  getDb()
    .prepare("UPDATE agents SET voice_by_provider_json = ?, updated_at = ? WHERE id = ?")
    .run(serialized, Date.now(), id);
}
