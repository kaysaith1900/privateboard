/**
 * SQLite connection + migration runner.
 *
 *   getDb()         singleton (opened once per process)
 *   runMigrations() applies any registered migrations not yet recorded
 *
 * Migrations are imported as text (tsup `.sql` loader), so they ship inside
 * dist/cli.js — no separate file copy step.
 */
import Database from "better-sqlite3";

import { statePath } from "../utils/paths.js";
import init001 from "./migrations/001_init.sql";
import opus002 from "./migrations/002_default_opus.sql";
import paused003 from "./migrations/003_paused_at.sql";
import intensity004 from "./migrations/004_room_intensity.sql";
import chair005 from "./migrations/005_chair.sql";
import clarify006 from "./migrations/006_awaiting_clarify.sql";
import tokens007 from "./migrations/007_agent_tokens.sql";
import memories008 from "./migrations/008_agent_memories.sql";
import skills009 from "./migrations/009_skills.sql";
import briefsMulti010 from "./migrations/010_briefs_multi.sql";
import agentAbility011 from "./migrations/011_agent_ability.sql";
import briefComposer012 from "./migrations/012_brief_composer.sql";
import retiredTokens013 from "./migrations/013_retired_token_usage.sql";
import agentWebSearch014 from "./migrations/014_agent_web_search.sql";
import webSearchDefaultOff015 from "./migrations/015_web_search_default_off.sql";
import prefsDefaultModel016 from "./migrations/016_prefs_default_model.sql";
import agentCarrierPref017 from "./migrations/017_agent_carrier_pref.sql";
import briefHouseStyle018 from "./migrations/018_brief_house_style.sql";
import roomSummaries019 from "./migrations/019_room_summaries.sql";
import roomFollowup020 from "./migrations/020_room_followup.sql";
import notes021 from "./migrations/021_notes.sql";
import intensityTerse022 from "./migrations/022_intensity_brutal_to_terse.sql";
import briefAssets023 from "./migrations/023_brief_assets.sql";
import usageDaily024 from "./migrations/024_usage_daily.sql";
import briefMode025 from "./migrations/025_brief_mode.sql";
import memoryMetabolism026 from "./migrations/026_memory_metabolism.sql";
import memoryMetabolismP2_027 from "./migrations/027_memory_metabolism_p2.sql";
import voiceMode028 from "./migrations/028_voice_mode.sql";
import webSearchProviderPref029 from "./migrations/029_web_search_provider_pref.sql";
import minimaxRegion030 from "./migrations/030_minimax_region.sql";
import agentPersonaSpec031 from "./migrations/031_agent_persona_spec.sql";
import roomVoteTrigger032 from "./migrations/032_room_vote_trigger.sql";
import roomMembersRemovedAt033 from "./migrations/033_room_members_removed_at.sql";
import briefViewerVariant034 from "./migrations/034_brief_viewer_variant.sql";
import agentHandleAt035 from "./migrations/035_agent_handle_at_prefix.sql";
import userTopicRecs036 from "./migrations/036_user_topic_recs.sql";
import topicRecTag037 from "./migrations/037_topic_rec_tag.sql";
import messageVoice038 from "./migrations/038_message_voice.sql";
import negativeSpace039 from "./migrations/039_negative_space.sql";
import topicBranches040 from "./migrations/040_topic_branches.sql";
import qdArchive041 from "./migrations/041_qd_archive.sql";
import remapRemovedModels042 from "./migrations/042_remap_removed_models.sql";
import remapKimiK25ToK26_043 from "./migrations/043_remap_kimi_k2_5_to_k2_6.sql";
import oneActiveLlmKey044 from "./migrations/044_one_active_llm_key.sql";
import activeLlmProviderPref045 from "./migrations/045_active_llm_provider_pref.sql";
import llmCredentials046 from "./migrations/046_llm_credentials.sql";
import dropTopicRecs047 from "./migrations/047_drop_topic_recs.sql";
import userLongMemory048 from "./migrations/048_user_long_memory.sql";
import voiceCredentials049 from "./migrations/049_voice_credentials.sql";
import agentProviderBuckets050 from "./migrations/050_agent_provider_buckets.sql";
import searchCredentials051 from "./migrations/051_search_credentials.sql";
import roomNameAuto052 from "./migrations/052_room_name_auto.sql";
import roomThreads053 from "./migrations/053_room_threads.sql";
import voiceCloneJobs054 from "./migrations/054_voice_clone_jobs.sql";
import voiceLabels055 from "./migrations/055_voice_labels.sql";
import agentUserRules056 from "./migrations/056_agent_user_rules.sql";
import agentAvatar3d057 from "./migrations/057_agent_avatar3d.sql";
import prefsAvatar3d058 from "./migrations/058_prefs_avatar3d.sql";
import voiceDistillJobs059 from "./migrations/059_voice_distill_jobs.sql";

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { name: "001_init.sql",         sql: init001 },
  { name: "002_default_opus.sql", sql: opus002 },
  { name: "003_paused_at.sql",    sql: paused003 },
  { name: "004_room_intensity.sql", sql: intensity004 },
  { name: "005_chair.sql", sql: chair005 },
  { name: "006_awaiting_clarify.sql", sql: clarify006 },
  { name: "007_agent_tokens.sql", sql: tokens007 },
  { name: "008_agent_memories.sql", sql: memories008 },
  { name: "009_skills.sql", sql: skills009 },
  { name: "010_briefs_multi.sql", sql: briefsMulti010 },
  { name: "011_agent_ability.sql", sql: agentAbility011 },
  { name: "012_brief_composer.sql", sql: briefComposer012 },
  { name: "013_retired_token_usage.sql", sql: retiredTokens013 },
  { name: "014_agent_web_search.sql", sql: agentWebSearch014 },
  { name: "015_web_search_default_off.sql", sql: webSearchDefaultOff015 },
  { name: "016_prefs_default_model.sql", sql: prefsDefaultModel016 },
  { name: "017_agent_carrier_pref.sql", sql: agentCarrierPref017 },
  { name: "018_brief_house_style.sql", sql: briefHouseStyle018 },
  { name: "019_room_summaries.sql", sql: roomSummaries019 },
  { name: "020_room_followup.sql", sql: roomFollowup020 },
  { name: "021_notes.sql", sql: notes021 },
  { name: "022_intensity_brutal_to_terse.sql", sql: intensityTerse022 },
  { name: "023_brief_assets.sql", sql: briefAssets023 },
  { name: "024_usage_daily.sql", sql: usageDaily024 },
  { name: "025_brief_mode.sql", sql: briefMode025 },
  { name: "026_memory_metabolism.sql", sql: memoryMetabolism026 },
  { name: "027_memory_metabolism_p2.sql", sql: memoryMetabolismP2_027 },
  { name: "028_voice_mode.sql", sql: voiceMode028 },
  { name: "029_web_search_provider_pref.sql", sql: webSearchProviderPref029 },
  { name: "030_minimax_region.sql", sql: minimaxRegion030 },
  { name: "031_agent_persona_spec.sql", sql: agentPersonaSpec031 },
  { name: "032_room_vote_trigger.sql", sql: roomVoteTrigger032 },
  { name: "033_room_members_removed_at.sql", sql: roomMembersRemovedAt033 },
  { name: "034_brief_viewer_variant.sql", sql: briefViewerVariant034 },
  { name: "035_agent_handle_at_prefix.sql", sql: agentHandleAt035 },
  { name: "036_user_topic_recs.sql", sql: userTopicRecs036 },
  { name: "037_topic_rec_tag.sql", sql: topicRecTag037 },
  { name: "038_message_voice.sql", sql: messageVoice038 },
  { name: "039_negative_space.sql", sql: negativeSpace039 },
  { name: "040_topic_branches.sql", sql: topicBranches040 },
  { name: "041_qd_archive.sql", sql: qdArchive041 },
  { name: "042_remap_removed_models.sql", sql: remapRemovedModels042 },
  { name: "043_remap_kimi_k2_5_to_k2_6.sql", sql: remapKimiK25ToK26_043 },
  { name: "044_one_active_llm_key.sql", sql: oneActiveLlmKey044 },
  { name: "045_active_llm_provider_pref.sql", sql: activeLlmProviderPref045 },
  { name: "046_llm_credentials.sql", sql: llmCredentials046 },
  { name: "047_drop_topic_recs.sql", sql: dropTopicRecs047 },
  { name: "048_user_long_memory.sql", sql: userLongMemory048 },
  { name: "049_voice_credentials.sql", sql: voiceCredentials049 },
  { name: "050_agent_provider_buckets.sql", sql: agentProviderBuckets050 },
  { name: "051_search_credentials.sql", sql: searchCredentials051 },
  { name: "052_room_name_auto.sql", sql: roomNameAuto052 },
  { name: "053_room_threads.sql", sql: roomThreads053 },
  { name: "054_voice_clone_jobs.sql", sql: voiceCloneJobs054 },
  { name: "055_voice_labels.sql", sql: voiceLabels055 },
  { name: "056_agent_user_rules.sql", sql: agentUserRules056 },
  { name: "057_agent_avatar3d.sql", sql: agentAvatar3d057 },
  { name: "058_prefs_avatar3d.sql", sql: prefsAvatar3d058 },
  { name: "059_voice_distill_jobs.sql", sql: voiceDistillJobs059 },
];

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const file = statePath();
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    // Force a WAL checkpoint before closing · without this, writes
    // sitting in state.db-wal (which can balloon to 4MB+ between
    // SQLite's lazy auto-checkpoints) only get merged into the main
    // db on next-start recovery. That recovery is usually fine but
    // has edge cases where partial transactions get rolled back —
    // the symptom is "user data disappears after restart." TRUNCATE
    // mode checkpoints + zeroes the WAL file so the on-disk state
    // is fully consistent the moment we close. */
    try { _db.pragma("wal_checkpoint(TRUNCATE)"); }
    catch { /* if checkpoint fails, plain close still flushes most data */ }
    _db.close();
    _db = null;
  }
}

/**
 * Apply registered migrations in declaration order. Each runs in a single
 * transaction; recorded by name so reruns are no-ops.
 */
export function runMigrations(): { applied: string[] } {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);

  const seen = new Set<string>(
    db
      .prepare("SELECT name FROM _migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const applied: string[] = [];
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");

  for (const m of MIGRATIONS) {
    if (seen.has(m.name)) continue;
    try {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        insert.run(m.name, Date.now());
      });
      tx();
      applied.push(m.name);
    } catch (e) {
      // "duplicate column name X" / "table X already exists" ·
      // the migration's structural work was already done by an
      // earlier-named migration on this db (typical after a
      // rebase that renumbered pending files; e.g. an upstream
      // PR slid in new migrations at 034-038 and pushed our
      // pending 041-044 down to 044-047). The data-side work in
      // these migrations is written to be idempotent (UPDATE …
      // WHERE col IS NULL is a no-op once seeded; INSERT FROM
      // provider_keys yields zero rows once the source was
      // emptied by the prior run; DROP TABLE IF EXISTS is
      // already idempotent), so the only thing that genuinely
      // fails is the structural ADD COLUMN / CREATE TABLE that
      // SQLite can't gate with IF NOT EXISTS. Record the
      // migration as applied so it doesn't try again next boot.
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate column name|already exists/i.test(msg)) {
        try { insert.run(m.name, Date.now()); }
        catch { /* _migrations row may already exist · ignore */ }
        process.stderr.write(
          `[migrations] ${m.name} · already applied (${msg.split("\n")[0]}); marked as recorded\n`,
        );
        applied.push(`${m.name} (no-op · already applied)`);
        continue;
      }
      throw e;
    }
  }

  return { applied };
}
