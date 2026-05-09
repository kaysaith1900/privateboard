import { describe, expect, it } from "vitest";

import { SentenceChunker } from "../src/voice/sentence-splitter.js";

describe("SentenceChunker", () => {
  it("emits complete Chinese and English sentences as tokens arrive", () => {
    const c = new SentenceChunker({ maxChars: 120 });
    expect(c.push("我先说结论")).toEqual([]);
    expect(c.push("。这个方案可以做")).toEqual(["我先说结论。"]);
    expect(c.push(" but we need a gate.")).toEqual(["这个方案可以做 but we need a gate."]);
  });

  it("forces a chunk when text grows too long without punctuation", () => {
    const c = new SentenceChunker({ maxChars: 16 });
    const out = c.push("没有标点的长句子会拖慢首音频所以要切开");
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBeLessThanOrEqual(16);
    expect(c.flush()).toBe("要切开");
  });

  it("flushes the remaining partial sentence at the end", () => {
    const c = new SentenceChunker();
    expect(c.push("One unfinished thought")).toEqual([]);
    expect(c.flush()).toBe("One unfinished thought");
    expect(c.flush()).toBeNull();
  });
});
