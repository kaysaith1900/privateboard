/* ═══════════════════════════════════════════════════════════════════
   store.js · offline persistence for the mobile prototype.

   Keeps user-created rooms, created directors, and adjourned-room
   archives (transcript + filed report) in localStorage so a reload
   doesn't wipe the user's work. Also tiny composer-draft helpers
   (CLAUDE.md rule: drafts must survive view switches / refresh).

   This is intentionally the seam a future backend swaps in behind:
   replace these reads/writes with REST + SSE and nothing else moves.
   ═══════════════════════════════════════════════════════════════════ */

const STATE_KEY = "pb_proto_state";

export function loadStore() {
  try { const s = localStorage.getItem(STATE_KEY); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
export function saveStore(obj) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(obj)); } catch (_) { /* quota / private mode → silently skip */ }
}

/* Composer drafts · keyed free-text that must persist across view
   switches and reload, cleared on successful submit. */
export function loadDraft(key) { try { return localStorage.getItem("pb_proto_draft_" + key) || ""; } catch (_) { return ""; } }
export function saveDraft(key, val) { try { localStorage.setItem("pb_proto_draft_" + key, val == null ? "" : String(val)); } catch (_) { /* */ } }
export function clearDraft(key) { try { localStorage.removeItem("pb_proto_draft_" + key); } catch (_) { /* */ } }
