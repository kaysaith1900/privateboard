/** Coerce arbitrary client / JSON payloads into a supported brief mode.
 *  Accepts case noise and a few synonyms so stray whitespace or tooling
 *  quirks don't silently fall through to `research-note` after an
 *  explicit slides/magazine pick. */
export function coerceBriefMode(
  raw: unknown,
): "research-note" | "magazine" | "newspaper" | "ppt" {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "magazine") return "magazine";
  if (s === "newspaper") return "newspaper";
  if (s === "ppt" || s === "slides" || s === "slide" || s === "deck") return "ppt";
  if (s === "research-note" || s === "report" || s === "memo" || s === "note") {
    return "research-note";
  }
  return "research-note";
}
