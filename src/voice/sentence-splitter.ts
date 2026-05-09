export interface SentenceChunkerOptions {
  maxChars?: number;
}

const END_RE = /[。！？!?；;：:\n]|[.](?=\s|$)/;

export class SentenceChunker {
  private buf = "";
  private readonly maxChars: number;

  constructor(opts: SentenceChunkerOptions = {}) {
    this.maxChars = Math.max(16, Math.floor(opts.maxChars ?? 100));
  }

  push(delta: string): string[] {
    if (!delta) return [];
    this.buf += delta;
    const out: string[] = [];
    while (this.buf.trim().length > 0) {
      const trimmedStart = this.buf.replace(/^\s+/, "");
      const leading = this.buf.length - trimmedStart.length;
      if (leading) this.buf = trimmedStart;

      const m = END_RE.exec(this.buf);
      if (m && m.index + 1 > 0) {
        const end = m.index + 1;
        const chunk = this.buf.slice(0, end).trim();
        this.buf = this.buf.slice(end);
        if (chunk) out.push(chunk);
        continue;
      }

      if (this.buf.length >= this.maxChars) {
        let cut = this.findSoftCut(this.buf, this.maxChars);
        if (cut <= 0) cut = this.maxChars;
        const chunk = this.buf.slice(0, cut).trim();
        this.buf = this.buf.slice(cut);
        if (chunk) out.push(chunk);
        continue;
      }
      break;
    }
    return out;
  }

  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? rest : null;
  }

  private findSoftCut(s: string, limit: number): number {
    const window = s.slice(0, limit);
    const candidates = ["，", ",", "、", " "];
    let best = -1;
    for (const c of candidates) {
      const idx = window.lastIndexOf(c);
      if (idx > best) best = idx + c.length;
    }
    return best;
  }
}
