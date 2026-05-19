# Export Eval

Export eval 评测 adjourn 后的 brief / report 产物：是否忠实于 room transcript、结构是否完整、语气是否匹配、renderer 和 PDF / PNG 导出是否稳定。

## What It Tests

- transcript-to-report fidelity
- preservation of disagreements and open questions
- report structure and reader value
- house style / spine fit
- `public/report.html` render quality
- PDF / PNG export stability

## Structure

```text
eval/export/
├── README.md
├── cases/
├── rubrics/
│   └── export-quality.md
└── runs/
```

## How To Run Manually

1. Run the source room case.
2. Adjourn the room and wait for brief generation to complete.
3. Review final markdown and rendered report.
4. Check desktop and mobile viewport rendering.
5. Export PDF / PNG where supported.
6. Score with `eval/export/rubrics/export-quality.md`.
7. Save the result under `eval/export/runs/`.

## Current Cases

- `cases/pricing-strategy.zh.md`: checks whether pricing-strategy room output becomes a faithful strategy report.
- `cases/user-correction.zh.md`: checks whether report preserves the user's mid-room correction.
