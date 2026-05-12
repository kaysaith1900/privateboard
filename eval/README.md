# PrivateBoard Eval

PrivateBoard eval 分三层，分别定位不同 failure owner。

```text
eval/
├── room/      # 多 agent room 沟通质量
├── export/    # brief / report 导出质量
└── agent/     # 单个 director 的讨论资格
```

## Room Eval

`eval/room/` 评测多 agent 讨论系统本身：

- chair 是否理解问题并正确澄清。
- director cast 是否互补。
- 讨论是否产生高质量分歧。
- 用户是否能 continue、纠偏、adjourn。
- room 是否让用户的问题更可判断、更可行动。

入口：

- `eval/room/README.md`
- `eval/room/cases/`
- `eval/room/rubrics/room-quality.md`
- `eval/room/runs/`

## Export Eval

`eval/export/` 评测 adjourn 后的 brief / report 产物：

- report 是否忠实于 transcript。
- 是否保留关键分歧、风险和 open questions。
- house style / spine 是否匹配 room tone。
- `public/report.html` 是否稳定渲染。
- PDF / PNG 导出是否完整可读。

入口：

- `eval/export/README.md`
- `eval/export/cases/`
- `eval/export/rubrics/export-quality.md`
- `eval/export/runs/`

## Agent Eval

`eval/agent/` 评测单个 director 是否有资格进入高质量 room：

- lens 是否清晰、可区分。
- 是否能提供非模板化观点。
- 是否能说出 falsifier 和边界。
- 信息不足时是否先问关键问题。
- 用户纠偏后是否更新方向。
- 面对相反观点时是否能形成建设性张力。

入口：

- `eval/agent/README.md`
- `eval/agent/cases/`
- `eval/agent/rubrics/single-agent-quality.md`
- `eval/agent/runs/`

## Shared Principles

1. **端到端优先**
   Room / export eval 从真实用户问题开始，尽量跑完整链路。单 agent eval 则固定压力题，保证不同 agent 可比较。
2. **忠实高于流畅**
   文笔顺滑但虚构事实、掩盖分歧或过度确定，应判为失败。
3. **推进质量高于发言数量**
   好输出应该让问题更清楚、更可验证、更可行动。
4. **可复现**
   每条 run 记录 case、模型配置、room id / brief id、评分证据和失败归因。
5. **人工裁判 + 结构化 rubric**
   LLM judge 可以辅助预筛，但关键门禁应保留人工抽检。

## Current Baseline Runs

- `eval/export/runs/pricing-strategy-2026-05-12.md`
- `eval/room/runs/2026-05-12/sparse-input.md`
- `eval/agent/runs/socrates-pricing-strategy-2026-05-12.md`

## Quick Start

### 1. Start PrivateBoard

```bash
npm run dev
```

The eval scripts assume the local server is reachable at `http://127.0.0.1:3030` and that state is stored in `~/.boardroom/state.db`.

### 2. Run An Agent Eval

Validate a case without spending model tokens:

```bash
node eval/agent/scripts/run-agent-case.mjs \
  socrates \
  eval/agent/cases/pricing-strategy.zh.md \
  --dry-run
```

Run the case:

```bash
node eval/agent/scripts/run-agent-case.mjs \
  socrates \
  eval/agent/cases/pricing-strategy.zh.md
```

Then open the generated draft in `eval/agent/runs/`, score it with `eval/agent/rubrics/single-agent-quality.md`, and rename it from `.draft.md` after review.

Suggested first baseline:

```bash
node eval/agent/scripts/run-agent-case.mjs socrates eval/agent/cases/pricing-strategy.zh.md
node eval/agent/scripts/run-agent-case.mjs user-empathy eval/agent/cases/pricing-strategy.zh.md
node eval/agent/scripts/run-agent-case.mjs first-principles eval/agent/cases/sparse-input.zh.md
```

### 3. Run A Room Eval

Room eval is currently manual:

1. Pick a case from `eval/room/cases/`.
2. Create a room with the specified mode and directors.
3. Let it run to the target turn count, or stop at clarification if the case expects clarification.
4. Score with `eval/room/rubrics/room-quality.md`.
5. Save under `eval/room/runs/<date>/`.

### 4. Run An Export Eval

Export eval starts from a completed room:

1. Adjourn the room and wait for the brief to finish.
2. Open the report page with `r=<roomId>&b=<briefId>`.
3. Check final markdown, desktop render, mobile render, and PDF / PNG export.
4. Score with `eval/export/rubrics/export-quality.md`.
5. Save under `eval/export/runs/`.
