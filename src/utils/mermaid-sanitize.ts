/**
 * Frontend-shared mermaid sanitizer · also exported from here so it can
 * be unit-tested. The implementation in public/report.html mirrors this
 * logic (it can't import — public/ is plain JS); keep the two in sync.
 *
 * Empirical findings (mermaid 10.9.5, verified via mermaid.parse on real
 * failing briefs):
 *
 *   · The lexer for `quadrantChart` only accepts ASCII alphanumerics +
 *     spaces inside UNQUOTED axis-end / quadrant / item labels. The
 *     moment a CJK character, paren, `+`, `/`, comma, etc. appears,
 *     parse fails with "Unrecognized text".
 *   · Wrapping the same label in double quotes makes parse succeed.
 *   · Title alone is exempt — it accepts almost anything to end-of-line.
 *
 * Strategy: ALWAYS wrap axis ends, item labels, and quadrant labels in
 * double quotes; strip characters that would close the quote prematurely
 * (`"`, `[`, `]`); normalize fullwidth punctuation to halfwidth or to a
 * space. The double-quoted form parses cleanly across English, CJK, and
 * mixed content.
 *
 * Touches only `quadrantChart` blocks — every other diagram type passes
 * through unchanged.
 */

export function sanitizeMermaid(src: string): string {
  if (!src) return src;
  if (!/^\s*quadrantChart\b/i.test(src)) return src;

  return src
    .split("\n")
    .map((line) => {
      const indentMatch = /^(\s*)/.exec(line);
      const indent = indentMatch ? indentMatch[1] || "    " : "    ";
      const t = line.trim();
      if (!t) return line;

      // Title · clean punctuation but DO NOT quote — mermaid's title
      // lexer accepts arbitrary text up to newline.
      const titleM = /^title\s+(.+)$/i.exec(t);
      if (titleM) {
        return `${indent}title ${cleanLabel(titleM[1])}`;
      }

      // Axis lines · always emit `x-axis "Low {l}" --> "High {l}"`.
      const ax = /^(x-axis|y-axis)\s+(.+)$/i.exec(t);
      if (ax) {
        const which = ax[1].toLowerCase();
        const rest = ax[2].trim();
        if (rest.includes("-->")) {
          const parts = rest.split("-->").map((s) => cleanLabel(s));
          if (parts.length === 2 && parts[0] && parts[1]) {
            return `${indent}${which} "${parts[0]}" --> "${parts[1]}"`;
          }
        }
        const cleaned = cleanLabel(rest);
        return `${indent}${which} "Low ${cleaned}" --> "High ${cleaned}"`;
      }

      // Quadrant labels · always quote the label.
      const qM = /^(quadrant-[1-4])\s+(.+)$/i.exec(t);
      if (qM) return `${indent}${qM[1]} "${cleanLabel(qM[2])}"`;

      // Item lines · always quote the label, clamp coords.
      const item = /^"?([^"\[\]]+?)"?\s*:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*$/.exec(t);
      if (item) {
        const label = cleanLabel(item[1]);
        const x = clamp01(parseFloat(item[2]));
        const y = clamp01(parseFloat(item[3]));
        return `${indent}"${label}": [${x.toFixed(2)}, ${y.toFixed(2)}]`;
      }

      return line;
    })
    .join("\n");
}

/** Inside any label we strip:
 *   - characters that would close our wrapping double quote (`"`, `[`,
 *     `]`)
 *   - colons (mermaid uses `:` as the item-label/coords separator)
 *   - CJK fullwidth punctuation (normalized to halfwidth or space)
 * Slashes and `+` are kept — mermaid accepts them inside double quotes. */
function cleanLabel(s: string): string {
  return s
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/，/g, " ")
    .replace(/：/g, " ")
    .replace(/、/g, " ")
    .replace(/。/g, " ")
    .replace(/；/g, " ")
    .replace(/["'`\[\]:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0.02, Math.min(0.98, n));
}
