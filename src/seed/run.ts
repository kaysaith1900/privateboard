/**
 * Seeding · idempotent. Runs on every startup.
 *  - Director catalog: seeded once on first run (empty table).
 *  - Chair: ensured on every startup. The chair is system infrastructure,
 *    not a user-customizable director — if someone deletes it, the next
 *    boot puts it back. We also backfill chair membership into existing
 *    rooms so older transcripts gain a chair seamlessly.
 */
import { countAgents, getAgent, insertAgent, updateAgent } from "../storage/agents.js";
import { getDb } from "../storage/db.js";

import { SEED_CHAIR, CHAIR_ID } from "./chair.js";
import { SEED_DIRECTORS } from "./directors.js";

export interface SeedReport {
  insertedAgents: number;
  chairBackfilledRooms: number;
}

export function runSeed(): SeedReport {
  let inserted = 0;

  // First-run director seed.
  if (countAgents() === 0) {
    for (const d of SEED_DIRECTORS) {
      if (!getAgent(d.id)) {
        insertAgent(d);
        inserted++;
      }
    }
  } else {
    // Existing-install backfill · seed directors that exist but
    // predate the ability-axes addition will have ability=null in DB,
    // which makes the director-picker's diversity guardrail silently
    // no-op (it requires non-null ability data to compute lens
    // coverage). Patch the canonical ability profile onto any seed
    // director where it's missing. Other fields stay user-editable.
    for (const d of SEED_DIRECTORS) {
      const existing = getAgent(d.id);
      if (!existing) continue;
      if (!existing.ability && d.ability) {
        updateAgent(d.id, { ability: d.ability });
      }
    }
  }

  // Chair is always present. Existing installs may have an older
  // `instruction` (the host-prompt evolves) — force the canonical
  // SEED_CHAIR.instruction on every boot so prompt updates ship to
  // installed instances. The chair is system infrastructure for
  // structural behavior, but `modelV` is a USER preference: changing
  // the chair's model in the agent profile must persist across
  // restarts. We previously reset modelV here too, which meant every
  // boot wiped the user's choice — that's the bug.
  const existingChair = getAgent(CHAIR_ID);
  if (!existingChair) {
    insertAgent(SEED_CHAIR);
    inserted++;
  } else if (existingChair.instruction !== SEED_CHAIR.instruction) {
    updateAgent(CHAIR_ID, { instruction: SEED_CHAIR.instruction });
  }

  // Backfill: every existing room must include the chair as a member.
  // We add it at position -1 (above all directors) so it's never picked
  // by the round-robin queue, which expects directors at positions 0+.
  const db = getDb();
  const missing = db
    .prepare(
      `SELECT r.id AS room_id
         FROM rooms r
         LEFT JOIN room_members rm
           ON rm.room_id = r.id AND rm.agent_id = ?
        WHERE rm.agent_id IS NULL`,
    )
    .all(CHAIR_ID) as Array<{ room_id: string }>;
  const insert = db.prepare(
    "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES (?, ?, ?, ?)",
  );
  const now = Date.now();
  for (const row of missing) {
    insert.run(row.room_id, CHAIR_ID, -1, now);
  }

  return { insertedAgents: inserted, chairBackfilledRooms: missing.length };
}
