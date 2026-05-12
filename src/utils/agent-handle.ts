/**
 * Agent handle convention · canonical stored form is `@slug` (one sigil).
 * Legacy rows may still use `/slug`; lookup APIs accept either form.
 */

export const AGENT_HANDLE_SIGIL = "@";

/** Strip leading @ and / for slug comparisons (repeats collapsed). */
export function bareHandleSlug(handle: string): string {
  let s = handle.trim();
  while (s.startsWith("@") || s.startsWith("/")) {
    if (s.startsWith("@")) s = s.slice(1);
    else if (s.startsWith("/")) s = s.slice(1);
    else break;
  }
  return s.trim();
}

/** Stored handle · `@` + non-empty slug. */
export function canonicalAgentHandleFromSlug(slug: string): string {
  const base = bareHandleSlug(slug);
  if (!base) throw new Error("agent handle slug is empty");
  return `${AGENT_HANDLE_SIGIL}${base}`;
}

/**
 * Normalise API/user input to the canonical `@slug` we persist.
 * Accepts `foo`, `@foo`, `/foo`, `@@foo`.
 */
export function normalizeAgentHandleForStorage(raw: string): string {
  return canonicalAgentHandleFromSlug(raw);
}

/** Ordered candidates for SQLite lookup (exact-first, then canonical, then legacy slash). */
export function agentHandleLookupCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const slug = bareHandleSlug(trimmed);
  if (!slug) return [];
  const canonical = `${AGENT_HANDLE_SIGIL}${slug}`;
  const legacy = `/${slug}`;
  return [...new Set([trimmed, canonical, legacy])];
}
