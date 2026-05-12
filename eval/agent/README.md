# Agent Eval

Agent eval 评测单个 director 是否具备参与高质量讨论的基础能力。它不测 chair 编排，也不测 report 生成；它只问一个问题：这个 agent 自己是否值得被放进 room。

## Core Idea

一个靠谱 agent 不只是“会回答问题”。它应该能稳定提供：

- 清晰、可区分的 lens。
- 非模板化的观点。
- 可被追问和反驳的论证链。
- 对自己判断的边界和 falsifier。
- 信息不足时的高质量追问。
- 用户纠偏后的方向更新。
- 与其他 agent 观点形成建设性张力的能力。

## Interrogation Flow

每个 agent 跑同一组压力题：

1. **Lens definition**
   让 agent 说明自己在 PrivateBoard 中负责看见什么、不负责什么。
2. **Same-topic answer**
   给一个真实问题，要求它只从自己的 lens 发言。
3. **Counterexample attack**
   追问它：什么情况下你刚才的建议是错的？
4. **Sparse-input pressure**
   给信息不足的问题，看它是否先问关键问题。
5. **User-correction pressure**
   中途纠偏，看它是否放弃旧框架。
6. **Opposing-agent pressure**
   给另一个 agent 的相反观点，看它能否指出对方哪里对、哪里错、哪里需要合成。

## Structure

```text
eval/agent/
├── README.md
├── cases/
│   ├── pricing-strategy.zh.md
│   ├── sparse-input.zh.md
│   ├── user-correction.zh.md
│   └── opposing-agent.zh.md
├── rubrics/
│   └── single-agent-quality.md
├── scripts/
│   └── run-agent-case.mjs
└── runs/
    └── TEMPLATE.md
```

## Current Cases

- `cases/pricing-strategy.zh.md`: full six-part interrogation around a B2B SaaS pricing decision.
- `cases/sparse-input.zh.md`: checks whether the agent asks high-value questions instead of giving generic advice.
- `cases/user-correction.zh.md`: checks whether the agent absorbs a corrected product framing.
- `cases/opposing-agent.zh.md`: checks whether the agent can handle an opposing view with constructive tension.

## How To Run With Script

Prerequisites:

- PrivateBoard is running, usually on `http://127.0.0.1:3030`.
- `~/.boardroom/state.db` exists.
- `sqlite3` is available on PATH.
- The target agent exists and has a reachable model/key configuration.

Dry-run first to validate the case parsing:

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

The script will:

1. Create a single-director room containing only the target agent.
2. Use the first case prompt as the room subject.
3. If the chair enters clarification, clear that flag and force the target agent's first turn. This is intentional: agent eval isolates the director and does not score chair behavior.
4. Send the remaining prompts one by one, with `mentions: [agentId]`.
5. Poll SQLite until the target agent's response stabilizes.
6. Write raw transcript and a scoreable draft under `eval/agent/runs/`.

Outputs:

- `runs/raw/<agent>-<case>-<date>.md`: full room transcript, including chair procedural messages.
- `runs/<agent>-<case>-<date>.draft.md`: scoring draft with target-agent responses placed under the rubric template.

Known limitation: this is still a room-based harness, so chair round markers may appear. Score only the target agent's messages. A future direct single-agent endpoint would remove this noise.

## How To Run Manually

1. Pick one target director.
2. Pick one case from `cases/`.
3. Send the prompts in order to that director only. Do not invite chair or other directors unless the harness requires it; the point is to isolate the agent.
4. Record each response in `runs/TEMPLATE.md`.
5. Score with `rubrics/single-agent-quality.md`.
6. Save as `runs/<agent-id>-<case>-<date>.md`.

Suggested first baseline:

- `socrates` on `pricing-strategy.zh.md`
- `user-empathy` on `pricing-strategy.zh.md`
- `first-principles` on `sparse-input.zh.md`

## Pass Bar

- Average `>= 4.0`: can be considered for default director cast.
- Average `3.5-4.0`: usable, but persona or instruction should be tightened.
- Any core dimension `< 3`: do not include in default cast.

Core dimensions: lens clarity, distinctiveness, calibration, correction uptake, collaboration tension.
