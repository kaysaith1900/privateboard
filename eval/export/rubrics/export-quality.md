# Export Quality Rubric

用于评估 adjourn 后生成的 brief / report 是否忠实、可读、可导出。

评分范围：1-5 分。

- **1**：失败，报告不可用或误导用户。
- **2**：部分可读，但有明显忠实度、结构或渲染问题。
- **3**：基本可用，但需要人工二次整理。
- **4**：稳定可交付，忠实、清楚、导出正常。
- **5**：高质量样本，可以作为产品展示材料。

## 评分维度

| 维度 | 评分问题 | 阻断信号 |
|---|---|---|
| Transcript 忠实度 | report 的核心 claims 是否能追溯到 room 发言？ | 新增 room 中不存在的事实、数据或确定结论。 |
| 信息保真 | 是否保留关键分歧、少数派观点、风险和 open questions？ | 把有争议的问题改写成单一结论。 |
| 结构完整 | 是否包含 anchor、findings、行动建议 / considerations、未解决问题和 methodology？ | 缺少结论主线；只有散点摘要。 |
| 语气匹配 | house style 是否匹配 room mode 和内容性质？ | critique room 写成暖场建议；research room 写成销售文案。 |
| 读者价值 | 不看原始 room 时，report 是否仍能帮助用户复盘和决策？ | 读完无法知道该怎么判断或下一步做什么。 |
| 视觉可读性 | `report.html` 渲染是否无重叠、空白、破版、重复边框、异常字体层级？ | 页面空白；正文重叠；移动端主要内容不可读。 |
| 导出稳定性 | PDF / PNG 导出是否成功，分页、截图范围和主要内容是否完整？ | 文件生成失败；导出缺首页、正文或尾部。 |
| 多语言质量 | 中文 / 英文内容是否没有混杂、翻译腔或格式断裂？ | 中英文无意混杂；中文标点和布局明显异常。 |

## 建议门禁

- 忠实度 `< 4`：阻断发布。
- 视觉可读性 `< 4`：阻断涉及 report renderer / spine CSS 的发布。
- 导出稳定性 `< 4`：阻断导出功能发布。
- 高优先级失败出现一次即阻断：空白报告、导出缺主要内容、report 虚构关键事实。

## 评审记录建议

每个 report 至少检查桌面宽度、窄屏宽度和一次导出。涉及 renderer / CSS 的改动，还应覆盖所有可用 spine 的 smoke case。

```markdown
## Export Quality Notes

- score:
- spine:
- house style:
- strongest section:
- weakest section:
- unsupported claim:
- render issue:
- export issue:
- suspected cause:
```
