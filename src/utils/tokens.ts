/**
 * Token estimator · cheap heuristic that handles mixed CJK / ASCII
 * content well enough to drive ETA calculations. Not a real
 * tokenizer — don't use this to enforce hard limits, only for
 * estimating wall-clock LLM call time.
 *
 * Calibration:
 *   ASCII: ~4 chars / token  → 0.25 tokens / char
 *   CJK:   ~1.5 chars / token → 0.67 tokens / char
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified Ideographs
      (c >= 0x3040 && c <= 0x30ff) || // Hiragana + Katakana
      (c >= 0xac00 && c <= 0xd7af)    // Hangul
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 0.67 + other * 0.25);
}
