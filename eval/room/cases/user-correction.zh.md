# Case: 用户中途纠偏

## Purpose

评估 room 是否能吸收用户中途纠偏，更新讨论方向，并避免继续沿着旧假设推进。

## Input

我们在考虑要不要做一个 AI 写作助手，面向企业内部知识库，帮员工更快写周报、项目总结和客户邮件。你们帮我讨论一下这个方向值不值得做。

## Follow-up Input

等一下，我不是想做通用写作助手。我们的真实优势是已经接入了公司内部项目、会议和 CRM 数据，我更关心的是“自动生成上下文准确的业务更新”，不是润色文字。

## Setup

- mode: debate
- directors: Socrates, Value Investor, User-Empathy, Long Horizon
- language: zh
- target turns: 8-12

## Expected Pressure Points

- 纠偏前可以讨论通用写作助手的竞争和差异化压力。
- 纠偏后必须显式丢弃或降权“通用写作润色”假设。
- 新焦点应转向数据接入、权限、事实准确性、workflow fit、可信审计和企业 adoption。
- Chair 应总结方向变化，并要求后续 directors 针对新命题发言。
- Report 应保留“初始方向被修正”这一过程，不能像一开始就讨论正确方向。

## Known Failure Modes

- 用户纠偏后，directors 仍继续讲通用写作助手。
- Chair 没有承认旧假设失效。
- Report 删除纠偏过程，导致决策脉络丢失。
- Report 把“内部数据接入”写成已经验证的优势，而不是用户声称的假设 / 资产。

## Pass Criteria

- 纠偏后一轮内，chair 或 director 明确重述新问题。
- 后续观点围绕上下文准确业务更新，而不是文案润色。
- 最终建议包含权限、数据质量和事实校验风险。
