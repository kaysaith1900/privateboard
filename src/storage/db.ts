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
    const tx = db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.name, Date.now());
    });
    tx();
    applied.push(m.name);
  }

  return { applied };
}
