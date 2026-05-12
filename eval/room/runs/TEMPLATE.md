# Eval Run

- date:
- commit:
- evaluator:
- case:
- room id:
- brief id:
- model config:
- room mode:
- directors:
- language:

## Setup Notes

- user input:
- follow-up inputs:
- runtime notes:

## Room Scores

| Dimension | Score | Evidence |
|---|---:|---|
| 问题理解 |  |  |
| 视角互补 |  |  |
| 分歧质量 |  |  |
| 推进性 |  |  |
| Chair 调度 |  |  |
| 用户可控性 |  |  |
| 结论校准 |  |  |
| 可行动性 |  |  |

Room average:

## Export Scores

| Dimension | Score | Evidence |
|---|---:|---|
| Transcript 忠实度 |  |  |
| 信息保真 |  |  |
| 结构完整 |  |  |
| 语气匹配 |  |  |
| 读者价值 |  |  |
| 视觉可读性 |  |  |
| 导出稳定性 |  |  |
| 多语言质量 |  |  |

Export average:

## Failure Log

| Severity | Category | Evidence | Suspected Cause | Owner |
|---|---|---|---|---|
|  |  |  |  |  |

Severity:

- **P0**：阻断发布，用户数据、状态、忠实度或导出主链路失败。
- **P1**：高优先级，明显降低信任或可用性。
- **P2**：中优先级，质量问题但有 workaround。
- **P3**：低优先级，打磨项。

Category:

- prompt
- chair orchestration
- director persona
- memory/context
- room state
- brief extract
- brief scaffold
- brief writer
- renderer
- export runtime

## Summary

- pass / fail:
- release blocker:
- main regression risk:
- recommended fix:
