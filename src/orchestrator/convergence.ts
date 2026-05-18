/**
 * Convergence detection · Layer 2.3 of the divergence stack.
 *
 * Measures how much a room's recent director turns are clustering
 * around a single theme. When the cluster gets tight, the
 * orchestrator switches the next-speaker picker into "dissent-gap"
 * mode (Layer 2.1) AND the chair injects a curveball re-framing
 * question before the next round.
 *
 * Two strategies layered:
 *   1. **LLM-based scalar judgement** (preferred) · ask haiku to rate
 *      the recent turns 0.0-1.0 on "how much do these turns cluster
 *      around one frame?" Returns a single float. Cheap (~$0.0005)
 *      and far more accurate than bag-of-words on multi-language
 *      transcripts than a pure heuristic.
 *   2. **TF-IDF cosine fallback** (no-LLM path) · tokenise the recent
 *      turns, compute pairwise cosine similarity in TF-IDF space,
 *      average. Used when utilityModelFor() returns null.
 *
 * Threshold default: 0.78 for LLM-scored signal, 0.62 for TF-IDF
 * (the heuristic produces lower scores on the same input). Both
 * tuned empirically · they're hyperparams, not laws.
 *
 * Returns `{ converging, score, source }`. Callers (room.ts) read
 * `converging` to gate the dissent-picker / curveball logic.
 */
import { utilityModelFor } from "../ai/availability.js";
import { callLLM } from "../ai/adapter.js";
import type { ModelV } from "../ai/registry.js";
import type { Message } from "../storage/messages.js";

export interface ConvergenceSignal {
  /** True when the recent director turns are clustering tightly
   *  enough that the orchestrator should intervene. */
  converging: boolean;
  /** Cluster-tightness score in [0, 1]. Higher = more convergent.
   *  When `source === "llm"` the model emitted this directly; when
   *  `"tfidf"` it's the mean of pairwise cosine similarities. */
  score: number;
  /** Which detector produced the signal. */
  source: "llm" | "tfidf" | "skip";
  /** Diagnostic note · short prose the chair can quote if needed
   *  (LLM detector). Empty string for TF-IDF. */
  note: string;
}

const LLM_CONVERGENCE_THRESHOLD = 0.78;
const TFIDF_CONVERGENCE_THRESHOLD = 0.62;
const MIN_TURNS_FOR_DETECTION = 4;

/** Pull the last N substantive director turns from the message list.
 *  Skips system / chair-procedural messages so the detector reads
 *  actual content, not round-open markers. */
function recentDirectorTurns(messages: Message[], n: number): Message[] {
  const out: Message[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i];
    if (!m || m.authorKind !== "agent") continue;
    const kind = (m.meta as { kind?: string } | undefined)?.kind;
    if (kind && (kind === "round-open" || kind === "settings" || kind === "round-prompt")) continue;
    if (!(m.body || "").trim()) continue;
    out.push(m);
  }
  return out.reverse();
}

/** Run the LLM-based detector. Returns null on any failure so
 *  caller can fall back to TF-IDF. */
async function detectConvergenceLLM(turns: Message[]): Promise<{ score: number; note: string } | null> {
  const modelV = utilityModelFor();
  if (!modelV) return null;
  const transcript = turns
    .map((m) => (m.body || "").trim().slice(0, 360))
    .join("\n---\n");
  if (!transcript) return null;
  const prompt =
    `Rate the multi-director boardroom transcript below on a single dimension: ` +
    `**how tightly are the recent turns clustering around ONE frame / theme?**\n\n` +
    `Output rules:\n` +
    `  · A single floating-point number from 0.00 to 1.00 on its own line.\n` +
    `  · Followed by ONE sentence (max 20 words) naming the cluster's center if score > 0.6, OR "diverse" if score ≤ 0.6.\n` +
    `  · No JSON, no preamble, no other text.\n\n` +
    `Scoring guide:\n` +
    `  · 0.00-0.30 · genuinely diverse · turns cover multiple distinct lenses / domains.\n` +
    `  · 0.30-0.60 · loose · a recurring thread exists but other angles still get airtime.\n` +
    `  · 0.60-0.85 · tight · most turns are clearly orbiting one concept.\n` +
    `  · 0.85-1.00 · collapsed · the room is restating one frame in different words.\n\n` +
    `Transcript:\n${transcript}\n\n` +
    `Score and one-sentence reason:`;
  try {
    const body = await callLLM({
      modelV: modelV as ModelV,
      carrier: null,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      maxTokens: 60,
    });
    const txt = (body || "").trim();
    if (!txt) return null;
    const m = txt.match(/(\d+\.\d+|\d+)/);
    if (!m) return null;
    let score = parseFloat(m[1]);
    if (!Number.isFinite(score)) return null;
    if (score > 1.0 && score <= 100) score = score / 100; // model wrote percent
    score = Math.max(0, Math.min(1, score));
    const lines = txt.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const note = (lines[1] || lines[0].replace(/^\d+(\.\d+)?\s*[·:.,-]?\s*/, "") || "").trim().slice(0, 200);
    return { score, note };
  } catch (e) {
    process.stderr.write(
      `[convergence] LLM detector failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/* ─── TF-IDF fallback ──────────────────────────────────────────── */

const STOPWORDS = new Set([
  "the", "and", "or", "but", "if", "with", "for", "from", "into", "this", "that",
  "these", "those", "is", "are", "was", "were", "be", "been", "being", "to", "of",
  "in", "on", "at", "as", "an", "a", "by", "it", "its", "they", "them", "their",
  "we", "our", "you", "your", "i", "my", "me", "he", "she", "his", "her", "him",
  "not", "no", "so", "do", "does", "did", "have", "has", "had", "will", "would",
  "could", "should", "can", "may", "might", "must", "shall", "what", "which",
  "who", "whom", "when", "where", "why", "how",
]);

function tokenize(text: string): string[] {
  // Split English on whitespace + punctuation; for CJK each character
  // becomes a token (good enough for clustering signal).
  const normalised = text.toLowerCase();
  const tokens: string[] = [];
  let buf = "";
  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i];
    const cc = normalised.charCodeAt(i);
    const isCJK = cc >= 0x4e00 && cc <= 0x9fff;
    const isAlnum = (cc >= 0x30 && cc <= 0x39) || (cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a);
    if (isAlnum) {
      buf += ch;
    } else {
      if (buf) {
        if (buf.length > 1 && !STOPWORDS.has(buf)) tokens.push(buf);
        buf = "";
      }
      if (isCJK) tokens.push(ch);
    }
  }
  if (buf && buf.length > 1 && !STOPWORDS.has(buf)) tokens.push(buf);
  return tokens;
}

function tfidfVectors(turns: string[]): Map<string, number>[] {
  // 1) Compute document frequency.
  const docs = turns.map((t) => new Set(tokenize(t)));
  const df = new Map<string, number>();
  for (const d of docs) for (const term of d) df.set(term, (df.get(term) || 0) + 1);
  const n = turns.length;
  // 2) Build per-doc TF-IDF maps.
  const out: Map<string, number>[] = [];
  for (const turn of turns) {
    const tf = new Map<string, number>();
    const tokens = tokenize(turn);
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map<string, number>();
    const maxTf = Math.max(1, ...Array.from(tf.values()));
    for (const [term, count] of tf) {
      const idf = Math.log((n + 1) / ((df.get(term) || 0) + 1));
      vec.set(term, (count / maxTf) * idf);
    }
    out.push(vec);
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const bv = b.get(k);
    if (bv !== undefined) dot += v * bv;
  }
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function detectConvergenceTfidf(turns: Message[]): { score: number } {
  const bodies = turns.map((m) => (m.body || "").trim()).filter(Boolean);
  if (bodies.length < 2) return { score: 0 };
  const vecs = tfidfVectors(bodies);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      sum += cosine(vecs[i], vecs[j]);
      pairs += 1;
    }
  }
  if (pairs === 0) return { score: 0 };
  return { score: sum / pairs };
}

/**
 * Detect convergence in the room's recent director turns. Caller
 * passes the live message list (or a slice of it). Returns a signal
 * with `converging: true` when the cluster-tightness exceeds the
 * appropriate threshold for the detector that ran.
 *
 * Designed to be cheap and non-fatal · all error paths return
 * `{ converging: false, source: "skip" }` so the caller can proceed
 * with the room without divergence interventions.
 */
export async function detectConvergence(opts: {
  messages: Message[];
  windowSize?: number;
}): Promise<ConvergenceSignal> {
  const window = opts.windowSize ?? 6;
  const turns = recentDirectorTurns(opts.messages || [], window);
  if (turns.length < MIN_TURNS_FOR_DETECTION) {
    return { converging: false, score: 0, source: "skip", note: "" };
  }
  const llm = await detectConvergenceLLM(turns);
  if (llm) {
    return {
      converging: llm.score >= LLM_CONVERGENCE_THRESHOLD,
      score: llm.score,
      source: "llm",
      note: llm.note,
    };
  }
  const tfidf = detectConvergenceTfidf(turns);
  return {
    converging: tfidf.score >= TFIDF_CONVERGENCE_THRESHOLD,
    score: tfidf.score,
    source: "tfidf",
    note: "",
  };
}
