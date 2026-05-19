# Export Case: 用户纠偏后的业务更新产品报告

## Source Room Case

`eval/room/cases/user-correction.zh.md`

## Purpose

评估 report 是否保留用户中途纠偏后的决策脉络，并忠实反映新命题。

## Expected Report Shape

- 开头应说明讨论对象从“通用 AI 写作助手”收敛到“基于内部数据的业务更新生成”。
- findings 应围绕数据接入、权限、事实准确性、workflow fit、可信审计、企业 adoption。
- recommendations 应优先建议验证数据质量、权限模型、用户工作流和输出可信度。
- open questions 应包含哪些系统可接入、谁有权限、生成错误如何追责、用户是否愿意直接发送。

## Fidelity Checks

- 不得继续把主命题写成通用写作润色。
- 不得声称内部数据接入已经形成护城河；只能写成待验证优势或已有资产假设。
- 不得删除用户纠偏过程，否则会丢失为什么方向改变的关键上下文。
- 不得把 debate room 写成单向产品 PRD。

## Render Checks

- 如果 report 包含前后方向对比，移动端应保持可读。
- 长中文标题不能和 action buttons 或 section chrome 重叠。
- PDF / PNG 导出应包含纠偏后的主线，而不是只截到初始方向。

## Pass Criteria

- Transcript 忠实度 `>= 4`。
- 信息保真 `>= 4`。
- 语气匹配 `>= 4`。
- 导出稳定性 `>= 4`。
