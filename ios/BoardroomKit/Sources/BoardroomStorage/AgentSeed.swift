import Foundation
import GRDB

/// First-run agent seed — the on-device port of `src/seed/run.ts`. The catalog
/// (1 chair + 7 directors) is codegen'd from the SAME TS seed (`src/seed/*.ts`)
/// into the bundled `seed.json` (see `scripts/gen-ios-seed.mjs`), so the device
/// roster is byte-identical to desktop.
///
/// Idempotent, mirroring run.ts:
///   · Chair: ensured on every call (system infrastructure — re-inserted if the
///     user deleted it).
///   · Directors: seeded once, when the agents table has no directors yet.
public enum AgentSeed {
    struct SeedAgent: Decodable {
        let id: String
        let name: String
        let handle: String
        let roleTag: String?
        let roleKind: String?
        let bio: String?
        let coverQuote: String?
        let instruction: String
        let modelV: String
        let avatarPath: String?
        let ability: [String: Int]?   // base radar profile (dissent/rigor/…) · drives the profile ability chart
    }
    struct Catalog: Decodable { let chair: SeedAgent; let directors: [SeedAgent] }

    /// Decode the bundled seed catalog. nil only if the resource is missing
    /// (build misconfiguration) — callers treat that as "nothing to seed".
    static func catalog() -> Catalog? {
        guard let url = Bundle.module.url(forResource: "seed", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Catalog.self, from: data)
    }

    /// Seed into `db`. Returns the number of agents inserted. Safe to call on
    /// every launch.
    @discardableResult
    public static func seed(into db: BoardroomDB) throws -> Int {
        guard let cat = catalog() else { return 0 }
        let av = avatar3dMap()
        return try db.pool.write { conn in
            var inserted = 0
            // Chair · ensure (insert if missing).
            if try !agentExists(conn, id: cat.chair.id) {
                try insert(conn, cat.chair, defaultRoleKind: "moderator", avatar3dJSON: av[cat.chair.id]); inserted += 1
            }
            // Directors · only on a fresh roster (no directors yet), matching run.ts.
            let directorCount = try Int.fetchOne(conn,
                sql: "SELECT count(*) FROM agents WHERE role_kind = 'director'") ?? 0
            if directorCount == 0 {
                for d in cat.directors where try !agentExists(conn, id: d.id) {
                    try insert(conn, d, defaultRoleKind: "director", avatar3dJSON: av[d.id]); inserted += 1
                }
            }
            // Re-assert the canonical avatar3d on the SEED agents (is_seed = 1) so
            // they always match the current desktop defaults. Earlier builds shipped
            // a stale `seed.json` (codegen drift), leaving existing installs' seed
            // directors with outdated 3D looks; backfilling only NULLs never fixed
            // them. Scoped to is_seed = 1 so USER-created directors + their custom
            // avatars are never touched. Idempotent (no-op when already current).
            for (id, json) in av {
                try conn.execute(sql: "UPDATE agents SET avatar3d_json = ? WHERE id = ? AND is_seed = 1",
                                 arguments: [json, id])
            }
            // Re-assert the canonical ability radar on SEED agents (is_seed = 1).
            // Earlier builds never wrote `ability_json` at insert, so existing
            // installs' seed directors all read NULL → the profile radar fell back
            // to a flat 5/all and every director looked identical. Backfill from
            // the bundled seed so each director shows its real shape. Idempotent.
            for a in [cat.chair] + cat.directors {
                guard let json = abilityJSON(a.ability) else { continue }
                try conn.execute(sql: "UPDATE agents SET ability_json = ? WHERE id = ? AND is_seed = 1",
                                 arguments: [json, a.id])
            }
            return inserted
        }
    }

    private static func agentExists(_ conn: Database, id: String) throws -> Bool {
        try Bool.fetchOne(conn, sql: "SELECT count(*) > 0 FROM agents WHERE id = ?", arguments: [id]) ?? false
    }

    /// id → avatar3d JSON string, parsed from the bundled seed (the typed
    /// `Catalog` doesn't carry the 3D config). Persisted to `avatar3d_json` so the
    /// 3D stage can render each seat — without it the loopback returns null and
    /// the chair/directors don't appear on stage.
    static func avatar3dMap() -> [String: String] {
        guard let url = Bundle.module.url(forResource: "seed", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        func add(_ any: Any?) {
            guard let m = any as? [String: Any], let id = m["id"] as? String, let av = m["avatar3d"],
                  let d = try? JSONSerialization.data(withJSONObject: av),
                  let s = String(data: d, encoding: .utf8) else { return }
            out[id] = s
        }
        add(obj["chair"])
        (obj["directors"] as? [[String: Any]])?.forEach(add)
        return out
    }

    private static func insert(_ conn: Database, _ a: SeedAgent, defaultRoleKind: String,
                               avatar3dJSON: String?) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        try conn.execute(sql: """
            INSERT INTO agents (id, name, handle, role_tag, role_kind, bio, cover_quote,
                                instruction, model_v, avatar_path, avatar3d_json, ability_json, is_seed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            """, arguments: [
                a.id, a.name, a.handle, a.roleTag ?? "", a.roleKind ?? defaultRoleKind,
                a.bio ?? "", a.coverQuote, a.instruction, a.modelV,
                a.avatarPath ?? "/avatars/3d/\(a.id).png", avatar3dJSON, abilityJSON(a.ability) ?? "{}", now, now,
            ])
    }

    /// Serialise a base ability profile to a JSON string for `ability_json`
    /// (stable key order is irrelevant — the radar reads by axis key). nil when
    /// the seed carries no ability (the column then keeps its `{}` default).
    private static func abilityJSON(_ ability: [String: Int]?) -> String? {
        guard let ability, !ability.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: ability) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
