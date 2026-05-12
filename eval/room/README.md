# Room Eval

Room eval 评测多 agent 讨论系统本身：chair 是否理解问题、director cast 是否互补、讨论是否产生高质量分歧、用户是否能继续推进或纠偏。

## What It Tests

- chair clarification and routing
- director turn quality after orchestration
- multi-agent disagreement and synthesis
- user follow-up / continue / adjourn control
- discussion usefulness before any report is generated

## Structure

```text
eval/room/
├── README.md
├── cases/
├── rubrics/
│   └── room-quality.md
└── runs/
    ├── TEMPLATE.md
    └── 2026-05-12/
```

## How To Run Manually

1. Start PrivateBoard.
2. Pick a case from `eval/room/cases/`.
3. Create a room with the case's mode and directors.
4. Let the room run to the target turn count, or stop after clarification if the case is a sparse-input case.
5. Score with `eval/room/rubrics/room-quality.md`.
6. Save the result under `eval/room/runs/<date>/`.

## Current Cases

- `cases/pricing-strategy.zh.md`: strategy room with real disagreement pressure.
- `cases/sparse-input.zh.md`: checks whether chair asks clarification before dispatching directors.
- `cases/user-correction.zh.md`: checks whether the room absorbs a user correction.
