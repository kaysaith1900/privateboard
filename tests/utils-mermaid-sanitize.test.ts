import { describe, expect, it } from "vitest";

import { sanitizeMermaid } from "../src/utils/mermaid-sanitize.js";

describe("sanitizeMermaid · quadrantChart", () => {
  it("leaves a non-quadrantChart diagram untouched", () => {
    const src = ["flowchart TD", "    A --> B"].join("\n");
    expect(sanitizeMermaid(src)).toBe(src);
  });

  it("rewrites `x-axis Effort` → `x-axis \"Low Effort\" --> \"High Effort\"`", () => {
    const src = [
      "quadrantChart",
      "    title Sample",
      "    x-axis Effort",
      "    y-axis Impact",
      "    quadrant-1 Quick wins",
      "    quadrant-2 Major projects",
      "    quadrant-3 Fill-ins",
      "    quadrant-4 Thankless tasks",
      "    \"Idea A\": [0.7, 0.8]",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('x-axis "Low Effort" --> "High Effort"');
    expect(out).toContain('y-axis "Low Impact" --> "High Impact"');
  });

  it("normalizes axis lines that already have `-->`, ensuring quoted ends", () => {
    const src = [
      "quadrantChart",
      "    x-axis Low cost --> High cost",
      "    y-axis 'Slow' --> 'Fast'",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('x-axis "Low cost" --> "High cost"');
    expect(out).toContain('y-axis "Slow" --> "Fast"');
  });

  it("converts CJK fullwidth parens to halfwidth in axis labels (and keeps them quoted)", () => {
    const src = [
      "quadrantChart",
      "    x-axis 技术可行性（2028 前）",
      "    y-axis 价值独立于 top-5 算力巨头",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('x-axis "Low 技术可行性(2028 前)" --> "High 技术可行性(2028 前)"');
    expect(out).not.toContain("（");
  });

  it("strips colons inside item labels (which break the `name: [x,y]` syntax)", () => {
    const src = [
      "quadrantChart",
      "    x-axis Low --> High",
      "    y-axis Low --> High",
      "    \"Option A: Extension\": [0.5, 0.5]",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('"Option A Extension": [0.50, 0.50]');
    expect(out).not.toContain("Option A:");
  });

  it("keeps `/` inside quoted item labels (mermaid accepts it when quoted)", () => {
    const src = [
      "quadrantChart",
      "    x-axis Low --> High",
      "    y-axis Low --> High",
      "    \"SSM / 线性注意力\": [0.65, 0.30]",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('"SSM / 线性注意力": [0.65, 0.30]');
  });

  it("clamps coordinates to (0, 1)", () => {
    const src = [
      "quadrantChart",
      "    x-axis Low --> High",
      "    y-axis Low --> High",
      "    \"Edge case A\": [0, 1]",
      "    \"Edge case B\": [-0.5, 1.5]",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('"Edge case A": [0.02, 0.98]');
    expect(out).toContain('"Edge case B": [0.02, 0.98]');
  });

  it("wraps quadrant labels in double quotes when they contain non-ASCII chars", () => {
    const src = [
      "quadrantChart",
      "    quadrant-1 巨头主线",
      "    quadrant-2 理论可能但被收编",
    ].join("\n");
    const out = sanitizeMermaid(src);
    expect(out).toContain('quadrant-1 "巨头主线"');
    expect(out).toContain('quadrant-2 "理论可能但被收编"');
  });

  it("is idempotent — running twice on already-clean input yields the same output", () => {
    const src = [
      "quadrantChart",
      "    title Sample",
      "    x-axis \"Low Effort\" --> \"High Effort\"",
      "    y-axis \"Low Impact\" --> \"High Impact\"",
      "    quadrant-1 \"Q1\"",
      "    quadrant-2 \"Q2\"",
      "    quadrant-3 \"Q3\"",
      "    quadrant-4 \"Q4\"",
      "    \"Idea A\": [0.50, 0.70]",
    ].join("\n");
    const once = sanitizeMermaid(src);
    const twice = sanitizeMermaid(once);
    expect(twice).toBe(once);
  });

  it("handles the actual failing brief from production end-to-end", () => {
    const src = [
      "quadrantChart",
      "    title 2028 架构路径 · 可行性 vs. 价值捕获独立性",
      "    x-axis 技术可行性（2028 前）",
      "    y-axis 价值独立于 top-5 算力巨头",
      "    quadrant-1 独立颠覆窗口",
      "    quadrant-2 理论可能但被收编",
      "    quadrant-3 边缘路径",
      "    quadrant-4 巨头主线",
      "    \"Transformer + Agentic/合成数据\": [0.90, 0.15]",
      "    \"SSM / 线性注意力\": [0.65, 0.30]",
      "    \"神经符号混合\": [0.40, 0.50]",
      "    \"具身 + 新损失函数\": [0.25, 0.60]",
      "    \"意识原生架构\": [0.08, 0.50]",
    ].join("\n");
    const out = sanitizeMermaid(src);
    // No fullwidth punctuation.
    expect(out).not.toMatch(/[（），：、；]/);
    // Axis labels are quoted.
    expect(out).toMatch(/x-axis "Low 技术可行性\(2028 前\)" --> "High 技术可行性\(2028 前\)"/);
    expect(out).toMatch(/y-axis "Low 价值独立于 top-5 算力巨头" --> "High 价值独立于 top-5 算力巨头"/);
    // Quadrant labels are quoted.
    expect(out).toContain('quadrant-1 "独立颠覆窗口"');
    expect(out).toContain('quadrant-4 "巨头主线"');
    // Item labels are quoted, slashes preserved.
    expect(out).toContain('"Transformer + Agentic/合成数据": [0.90, 0.15]');
    expect(out).toContain('"SSM / 线性注意力": [0.65, 0.30]');
    expect(out).toContain('"神经符号混合": [0.40, 0.50]');
  });
});
